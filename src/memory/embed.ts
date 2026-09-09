/**
 * 嵌入提供者（可插拔）
 *
 * 两种实现：
 *  - hashEmbed：字符 bigram 哈希袋（256 维，零依赖、确定性、中英文均可），离线默认
 *  - openaiEmbed：OpenAI 兼容 /v1/embeddings（async），真实语义质量
 *
 * MemoryLayer 统一按 async 使用 EmbedAsyncFn；hash 实现也包成 async 保持一致接口。
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

export interface OpenaiEmbedOptions {
  baseUrl: string
  model: string
  /** API key（从环境变量读取后传入，禁止硬编码） */
  apiKey: string
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
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          model: opts.model,
          input: batch,
          ...(opts.dimension && probedDim === 0 ? {} : opts.dimension ? { dimensions: opts.dimension } : {}),
        }),
      })
      if (!res.ok) throw new Error(`embedding API ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const json: any = await res.json()
      const vecs = (json.data as any[]).sort((a, b) => a.index - b.index).map((d) => d.embedding as number[])
      if (vecs.length !== batch.length) throw new Error('embedding batch length mismatch')
      if (probedDim === 0) probedDim = vecs[0].length
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

