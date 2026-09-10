/**
 * 嵌入提供者（可插拔）
 *
 * 两种实现：
 *  - hashEmbed：字符 bigram 哈希袋（256 维，零依赖、确定性、中英文均可），离线默认
 *  - openaiEmbed：OpenAI 兼容 /v1/embeddings（async），真实语义质量；
 *    同样适用于本地 Ollama（baseUrl=http://localhost:11434/v1，无需 apiKey）
 *
 * MemoryLayer 统一按 async 使用 EmbedAsyncFn；hash 实现也包成 async 保持一致接口。
 *
 * 统一契约：所有嵌入实现必须返回 L2 归一化的单位向量。zvec 向量索引默认度量为
 * 内积（IP），单位向量下点积即余弦相似度；hashEmbed 自带归一化，openaiEmbed
 * 在出口处 l2Normalize。新增 provider 也必须遵守，否则召回分数被模长主导、区分度失效。
 */

export type EmbedAsyncFn = (texts: string[]) => Promise<number[][]>

export const HASH_DIM = 256

/** FNV-1a 字符串哈希 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** 哈希袋嵌入：字符级 bigram（适配中文）+ 词级 unigram → 归一化投影 */
export function hashEmbedOne(text: string, dim = HASH_DIM): number[] {
  const vec = new Array<number>(dim).fill(0)
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim()
  const grams: string[] = []
  for (const word of norm.split(' ')) {
    grams.push(`w:${word}`)
    for (let i = 0; i < word.length - 1; i++) grams.push(word.slice(i, i + 2))
    if (word.length === 1) grams.push(word)
  }
  for (const g of grams) {
    const h = fnv1a(g)
    vec[h % dim] += (h & 1 ? 1 : -1) * (1 + (g.charCodeAt(0) % 3) * 0.2)
  }
  const l2 = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1
  return vec.map((v) => v / l2)
}

export const hashEmbed: EmbedAsyncFn = async (texts) => texts.map((t) => hashEmbedOne(t))

/** L2 归一化为单位向量（点积即余弦） */
export function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1
  return vec.map((v) => v / norm)
}

export interface OpenaiEmbedOptions {
  baseUrl: string
  model: string
  /** API key（从环境变量读取后传入，禁止硬编码）；本地 Ollama 无需 key，留空即可 */
  apiKey?: string
  dimension?: number
  /** 单请求批量上限（多数 API 支持数组输入） */
  batchSize?: number
}

/**
 * OpenAI 兼容 embeddings 客户端（fetch，无额外依赖）。
 * 一次批量嵌入多条文本，超出 batchSize 自动分批。
 */
export function openaiEmbed(opts: OpenaiEmbedOptions): EmbedAsyncFn {
  let probedDim = opts.dimension ?? 0
  return async (texts: string[]) => {
    const out: number[][] = []
    const size = opts.batchSize ?? 32
    for (let i = 0; i < texts.length; i += size) {
      const batch = texts.slice(i, i + size)
      const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: opts.model,
          input: batch,
          // 显式指定维度时每个请求都带 dimensions（Matryoshka 截断，如 bge-m3 1024→512）；
          // 未指定时不带参数、取模型原生维度
          ...(opts.dimension ? { dimensions: opts.dimension } : {}),
        }),
      })
      if (!res.ok) throw new Error(`embedding API ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const json: any = await res.json()
      // 契约：嵌入函数必须返回 L2 单位向量——zvec 默认度量为内积（IP），
      // 归一化后点积才等于余弦；API 返回的原始向量模长不一，必须在此归一化。
      const vecs = (json.data as any[])
        .sort((a, b) => a.index - b.index)
        .map((d) => l2Normalize(d.embedding as number[]))
      if (vecs.length !== batch.length) throw new Error('embedding batch length mismatch')
      if (probedDim === 0) probedDim = vecs[0].length
      else if (vecs[0].length !== probedDim)
        throw new Error(`embedding 维度不一致：首批 ${probedDim} 维，本批 ${vecs[0].length} 维（检查 dimensions 参数/模型）`)
      out.push(...vecs)
    }
    return out
  }
}

/** 余弦相似度（向量已归一化时点积即余弦） */
export function cosine(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

