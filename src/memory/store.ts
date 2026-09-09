/**
 * 记忆层（LAAP 五层记忆的 dsh-laap 实现 + zvec 向量库）
 *
 *  - 工作记忆：进程内环形缓冲（容量 7±2，Baddeley 模型），溢出降级归档
 *  - 情景记忆：zvec kind='episodic'，时间标记的事件流
 *  - 语义记忆：zvec kind='semantic'，事实与自我模型（自传蒸馏的落点）
 *  - 程序记忆：zvec kind='procedural'，技能与流程（"我怎么做过什么"）
 *
 * 向量检索由阿里巴巴开源的嵌入式向量数据库 zvec（Apache 2.0）承担：
 * 进程内、WAL 持久化、标量过滤下推。注意：库路径必须在本地文件系统
 * （mmap 依赖，OSS/NFS 网络挂载会 Bus error）；更换嵌入维度需删除旧库重建。
 */
import { ZVecCollectionSchema, ZVecCreateAndOpen, ZVecDataType, ZVecOpen } from '@zvec/zvec'
import { HASH_DIM, type EmbedAsyncFn } from './embed.ts'

export type MemoryKind = 'episodic' | 'semantic' | 'procedural'

export interface MemoryDoc {
  id: string
  kind: MemoryKind
  text: string
  ts: number
  /** 写入时刻的显著性（影响召回排序权重） */
  salience: number
  /** 来源认知模式，供 L4 策略分析 */
  mode?: string
}

export interface RecallResult {
  id: string
  kind: MemoryKind
  text: string
  ts: number
  /** 排序分 = 原始相似度 × 显著性先验 */
  score: number
  /** zvec 原始相似度（去重判定用，不含显著性加权） */
  rawScore: number
}

function buildSchema(dim: number) {
  return new ZVecCollectionSchema({
    name: 'laap_memory',
    vectors: { name: 'embedding', dataType: ZVecDataType.VECTOR_FP32, dimension: dim },
    fields: [
      { name: 'kind', dataType: ZVecDataType.STRING },
      { name: 'text', dataType: ZVecDataType.STRING },
      { name: 'ts', dataType: ZVecDataType.INT64 },
      { name: 'salience', dataType: ZVecDataType.FLOAT },
    ],
  })
}

export class MemoryLayer {
  private col: ReturnType<typeof ZVecCreateAndOpen>
  private embed: EmbedAsyncFn
  /** 工作记忆：容量受限的环形缓冲 */
  private working: string[] = []
  private workingCap = 7
  /** 程序记忆内存索引（技能名 → 文档），启动时从 zvec 重建 */
  private skills = new Map<string, MemoryDoc>()

  constructor(dbPath: string, embed: EmbedAsyncFn, dim = HASH_DIM) {
    this.embed = embed
    // 存在则打开（WAL 保证崩溃恢复），否则新建
    try {
      this.col = ZVecOpen(dbPath)
    } catch {
      this.col = ZVecCreateAndOpen(dbPath, buildSchema(dim))
    }
    this.reloadSkills()
  }

  /** 写入长期记忆（情景/语义/程序层）；semantic 层自动去重（近似即覆盖更新） */
  async remember(doc: MemoryDoc): Promise<{ id: string; deduplicated?: string }> {
    let deduplicated: string | undefined
    if (doc.kind === 'semantic') {
      const near = await this.recall(doc.text, { kind: 'semantic', topk: 1 })
      // 原始相似度 >0.92（哈希嵌入口径）视为同一事实：删旧写新，语义层不膨胀
      if (near[0] && near[0].id !== doc.id && near[0].rawScore > 0.92) {
        deduplicated = near[0].id
        try { this.col.deleteSync(deduplicated) } catch { /* 旧项可能已被并发删除 */ }
      }
    }
    const [vec] = await this.embed([doc.text])
    this.col.insertSync([
      {
        id: doc.id,
        vectors: { embedding: vec },
        fields: { kind: doc.kind, text: doc.text, ts: doc.ts, salience: doc.salience },
      },
    ])
    if (doc.kind === 'procedural') this.skills.set(doc.id, doc)
    return { id: doc.id, deduplicated }
  }

  /** 联想召回：向量相似度 + 可选标量过滤（kind 下推到索引执行层） */
  async recall(query: string, opts: { topk?: number; kind?: MemoryKind } = {}): Promise<RecallResult[]> {
    const { topk = 5, kind } = opts
    const [vec] = await this.embed([query])
    // zvec 的 filter 只接受非空字符串，无过滤时不能传 undefined
    const q: any = kind
      ? { fieldName: 'embedding', vector: vec, topk, filter: `kind = '${kind}'` }
      : { fieldName: 'embedding', vector: vec, topk }
    const hits = this.col.querySync(q)
    return hits
      .map((h: any) => ({
        id: h.id,
        kind: h.fields?.kind,
        text: h.fields?.text ?? '',
        ts: Number(h.fields?.ts ?? 0),
        // zvec score 为相似度（越大越近），排序分再叠加显著性先验
        rawScore: h.score ?? 0,
        score: (h.score ?? 0) * (1 + 0.3 * Number(h.fields?.salience ?? 0)),
      }))
      .sort((a, b) => b.score - a.score)
  }

  /** 程序记忆：已学会的技能清单（内存索引，按写入时间倒序） */
  listSkills(limit = 20): MemoryDoc[] {
    return [...this.skills.values()].sort((a, b) => b.ts - a.ts).slice(0, limit)
  }

  /** 启动重建：从 zvec 遍历 procedural 文档回填技能索引 */
  private reloadSkills(): void {
    try {
      const it: any = (this.col as any).iterDocsSync({})
      for (const doc of it ?? []) {
        const fields: any = doc?.fields ?? {}
        if (fields.kind === 'procedural') {
          this.skills.set(doc.id, {
            id: doc.id,
            kind: 'procedural',
            text: fields.text ?? '',
            ts: Number(fields.ts ?? 0),
            salience: Number(fields.salience ?? 0.5),
          })
        }
      }
    } catch {
      // 迭代接口异常时技能索引为空，不阻塞启动（召回仍可命中）
    }
  }

  /** 工作记忆入圈（自动挤出最旧项，挤出的项降级归档为情景记忆） */
  pushWorking(item: string, archiveTo?: { id: string; ts: number }): void {
    this.working.push(item)
    if (this.working.length > this.workingCap) {
      const dropped = this.working.shift()!
      if (archiveTo) {
        void this.remember({ id: archiveTo.id, kind: 'episodic', text: dropped, ts: archiveTo.ts, salience: 0.3 })
      }
    }
  }

  getWorking(): string[] {
    return [...this.working]
  }

  close(): void {
    this.col.closeSync()
  }
}

