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
import type { MemoryPort } from '../ports.ts'

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

export class MemoryLayer implements MemoryPort {
  private col: ReturnType<typeof ZVecCreateAndOpen>
  private embed: EmbedAsyncFn
  /** 工作记忆：容量受限的环形缓冲 */
  private working: string[] = []
  /** 与 working 平行的归档意图：每项入环时自带，被挤出时按它自己的标记落库 */
  private workingArchive: Array<{ id: string; ts: number } | undefined> = []
  private workingCap = 7
  /** 程序记忆内存索引（技能名 → 文档），启动时从 zvec 重建 */
  private skills = new Map<string, MemoryDoc>()
  /**
   * 语义层去重阈值（rawScore）：写入 semantic 前查 top-1 近邻，超阈值视为同一事实，
   * 删旧写新。口径随嵌入模型标定：
   *  - hash 袋嵌入默认 0.92（只有近乎逐字重复才够得着）；
   *  - 神经嵌入（bge-m3 实测）同一事实的不同写法 0.79~0.95、不同事实 ≤0.72，
   *    安全空档取 0.75。由适配层按 provider 注入，内核默认仍为 hash 口径。
   */
  private readonly semanticDedupThreshold: number
  /**
   * 情景记忆容量上界（条数；0 = 不限制）。
   * 情景层是近期事件流（长程沉淀由语义层自传承担），帧归档持续写入、无界会
   * 拖垮存储与召回质量；超限时按 ts 淘汰最旧记录。产品默认值由适配层注入。
   */
  private readonly episodicCap: number
  /** 情景记忆时间序索引（启动时全量重建；队首最旧，供容量上界淘汰） */
  private episodicQueue: Array<{ id: string; ts: number }> = []

  constructor(
    dbPath: string,
    embed: EmbedAsyncFn,
    dim = HASH_DIM,
    opts: { semanticDedupThreshold?: number; episodicCap?: number } = {},
  ) {
    this.embed = embed
    // 0 或未传 = 用 hash 口径默认（阈值 0 会让任意写入都误判重复，绝不采用）
    this.semanticDedupThreshold = opts.semanticDedupThreshold && opts.semanticDedupThreshold > 0
      ? opts.semanticDedupThreshold
      : 0.92
    this.episodicCap = opts.episodicCap && opts.episodicCap > 0 ? Math.floor(opts.episodicCap) : 0
    // 存在则打开（WAL 保证崩溃恢复），否则新建
    try {
      this.col = ZVecOpen(dbPath)
    } catch {
      this.col = ZVecCreateAndOpen(dbPath, buildSchema(dim))
    }
    this.reloadIndexes()
  }

  /** 写入长期记忆（情景/语义/程序层）；semantic 层自动去重（近似即覆盖更新） */
  async remember(doc: MemoryDoc): Promise<{ id: string; deduplicated?: string }> {
    let deduplicated: string | undefined
    if (doc.kind === 'semantic') {
      const near = await this.recall(doc.text, { kind: 'semantic', topk: 1 })
      // 超过去重阈值视为同一事实：删旧写新，语义层不膨胀（阈值随嵌入模型标定）
      if (near[0] && near[0].id !== doc.id && near[0].rawScore > this.semanticDedupThreshold) {
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
    if (doc.kind === 'episodic') {
      this.episodicQueue.push({ id: doc.id, ts: doc.ts })
      this.pruneEpisodic()
    }
    return { id: doc.id, deduplicated }
  }

  /** 情景层超容量时淘汰最旧记录（FIFO；长程经历由语义层自传保留） */
  private pruneEpisodic(): void {
    if (this.episodicCap <= 0) return
    while (this.episodicQueue.length > this.episodicCap) {
      const oldest = this.episodicQueue.shift()
      if (!oldest) break
      try { this.col.deleteSync(oldest.id) } catch { /* 可能已被外部删除 */ }
    }
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

  /** 删除一条长期记忆（技能更新时先删旧文再写合并文）；文档不存在时静默 */
  forget(id: string): void {
    try { this.col.deleteSync(id) } catch { /* 可能已被并发删除 */ }
    this.skills.delete(id)
  }

  /**
   * 启动重建：一次全量遍历回填两个内存索引——
   * procedural 技能索引（listSkills）与 episodic 时间序队列（容量淘汰）；
   * 存量已超上界时立即 prune（适配上调/下调 cap 的情形）。
   */
  private reloadIndexes(): void {
    try {
      const episodic: Array<{ id: string; ts: number }> = []
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
        } else if (fields.kind === 'episodic') {
          episodic.push({ id: doc.id, ts: Number(fields.ts ?? 0) })
        }
      }
      episodic.sort((a, b) => a.ts - b.ts)
      this.episodicQueue = episodic
      this.pruneEpisodic()
    } catch {
      // 迭代接口异常时内存索引为空，不阻塞启动（召回仍可命中；容量淘汰本轮停用）
    }
  }

  /**
   * 工作记忆入圈（自动挤出最旧项）。
   * archiveTo 是**本项自己的**归档标记：它后来被挤出时，按该标记以自己的
   * id/ts 沉淀为情景记忆；不传则挤出即弃（纯内感受帧的归档门槛由内核决定）。
   */
  pushWorking(item: string, archiveTo?: { id: string; ts: number }): void {
    this.working.push(item)
    this.workingArchive.push(archiveTo)
    if (this.working.length > this.workingCap) {
      const dropped = this.working.shift()!
      const meta = this.workingArchive.shift()
      if (meta) {
        // fire-and-forget 沉淀：必须吞掉 reject（内核 dispose/close 后
        // in-flight 写入会失败，未捕获时成为 unhandledRejection 拖垮进程退出码）
        void this.remember({ id: meta.id, kind: 'episodic', text: dropped, ts: meta.ts, salience: 0.3 })
          .catch(() => { /* 沉淀失败不影响主流程 */ })
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

