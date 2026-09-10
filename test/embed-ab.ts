/**
 * 嵌入 A/B 对比测试：hashEmbed（256 维字面哈希袋） vs openaiEmbed→Ollama nomic-embed-text（768 维语义模型）
 *
 * 同一组记忆语料、同一组「换说法」查询（查询与目标记忆字面尽量不重合，考语义），
 * 分别建库召回，对比：目标排名(Hit@1/Hit@3/MRR)、目标原始相似度、与最强干扰项的间隔。
 * 另含一条无答案控制查询（不应给出高分）。
 *
 * 用法：node --experimental-strip-types test/embed-ab.ts
 * 前提：本地 Ollama 在 127.0.0.1:11434 且已 pull nomic-embed-text。
 * 库目录用 tmpdir() 独立临时目录，测完即删，不碰 ~/.dsh-laap 正式记忆库。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'
import { MemoryLayer } from '../src/core/memory/store.ts'
import { hashEmbed, openaiEmbed, HASH_DIM } from '../src/core/memory/embed.ts'

/** 记忆语料（8 条事实，编号即 target 索引） */
const CORPUS: string[] = [
  '我喜欢简洁的代码，讨厌过度设计',
  'TypeScript 的装饰器本质上是一种元编程语法',
  'zvec 向量数据库依赖 mmap，库文件必须放在本地磁盘，网络挂载会崩溃',
  'LAAP 的意识状态由压力、信心、好奇、连接、能量五个维度构成',
  '用户偏好函数式风格，倾向不可变的数据处理',
  'dsh 会话压缩时，我会把近期经历蒸馏成阶段自传存入语义记忆',
  '桌宠被点击后有九十秒的清醒宽限期，期间不会入睡',
  '哈希嵌入是字符 bigram 的 FNV 哈希袋，共 256 维',
]

/** 查询 → 目标语料编号（-1 = 无答案控制项） */
const QUERIES: { q: string; target: number; note: string }[] = [
  { q: '你反感什么样的编程风格？', target: 0, note: '反感↔讨厌、编程↔代码，近义换词' },
  { q: '@decorator 那套语法到底是什么原理', target: 1, note: '英文 decorator↔中文装饰器，零字面重合' },
  { q: '向量库为什么不能放在网盘上？', target: 2, note: '网盘↔OSS/NFS 网络挂载' },
  { q: '你的情绪状态是用哪几个数值刻画的？', target: 3, note: '情绪/数值↔五维意识状态' },
  { q: 'map/reduce 那种数据流写法好在哪？', target: 4, note: '考函数式/不可变，无字面重合' },
  { q: '上下文快被清空的时候你会先做什么？', target: 5, note: '清空↔会话压缩' },
  { q: '点了宠物之后它过多久才会睡着？', target: 6, note: '睡↔清醒宽限' },
  { q: '什么是哈希嵌入？', target: 7, note: '【字面对照】查询与目标字面高度重合' },
  { q: '明天北京天气怎么样？', target: -1, note: '【无答案控制】不应有高相似度' },
]

interface SysResult {
  name: string
  hit1: number
  hit3: number
  mrr: number
  rows: { q: string; note: string; rank: number | null; targetScore: number | null; bestOther: number; margin: number | null }[]
  noMatchTop: number
  latencies: number[]
}

async function runSystem(name: string, layer: MemoryLayer): Promise<SysResult> {
  // 写入语料（episodic 层避免 semantic 去重干扰；id 用 ASCII 安全字符；显著性统一 0.7）
  const now = Date.now()
  for (let i = 0; i < CORPUS.length; i++) {
    await layer.remember({ id: `ab-${name}-${i}`, kind: 'episodic', text: CORPUS[i], ts: now + i, salience: 0.7 })
  }

  const rows: SysResult['rows'] = []
  let hit1 = 0, hit3 = 0, rrSum = 0, scorable = 0
  let noMatchTop = 0
  const latencies: number[] = []

  for (const { q, target, note } of QUERIES) {
    const t0 = Date.now()
    const hits = await layer.recall(q, { topk: CORPUS.length })
    latencies.push(Date.now() - t0)
    const targetId = target >= 0 ? `ab-${name}-${target}` : null
    const rank = targetId ? hits.findIndex((h) => h.id === targetId) + 1 : null
    const targetHit = rank ? hits[rank - 1] : null
    const targetScore = targetHit ? targetHit.rawScore : null
    const bestOther = hits.filter((_, i) => i + 1 !== rank).reduce((m, h) => Math.max(m, h.rawScore), 0)
    const margin = targetScore !== null ? targetScore - bestOther : null
    if (target >= 0) {
      scorable++
      if (rank === 1) hit1++
      if (rank && rank <= 3) hit3++
      if (rank) rrSum += 1 / rank
    } else {
      noMatchTop = hits[0]?.rawScore ?? 0
    }
    rows.push({ q, note, rank, targetScore, bestOther, margin })
  }

  return { name, hit1, hit3, mrr: rrSum / scorable, rows, noMatchTop, latencies }
}

function fmt(n: number | null, digits = 3): string {
  return n === null ? '  —  ' : n.toFixed(digits)
}

async function main() {
  // B 组模型可经环境变量切换：$env:LAAP_AB_MODEL='bge-m3'; $env:LAAP_AB_DIM='1024'
  const modelB = process.env.LAAP_AB_MODEL || 'nomic-embed-text'
  const dimB = Number(process.env.LAAP_AB_DIM || 768)
  const baseUrl = process.env.LAAP_AB_BASE_URL || 'http://127.0.0.1:11434/v1'

  const base = join(tmpdir(), `laap-embed-ab-${Date.now()}`)
  mkdirSync(base, { recursive: true })
  const dirA = join(base, 'hash')
  const dirB = join(base, modelB.replace(/[^a-z0-9]/gi, ''))

  console.log(`建库：A=hashEmbed(256维)  B=${modelB}(${dimB}维, ${baseUrl})\n`)
  const layerA = new MemoryLayer(dirA, hashEmbed, HASH_DIM)
  const embedB = openaiEmbed({ baseUrl, model: modelB, dimension: dimB })
  const layerB = new MemoryLayer(dirB, embedB, dimB)

  let ra: SysResult, rb: SysResult
  try {
    ra = await runSystem('hash', layerA)
    console.log(`A 组（哈希）完成，开始 B 组（${modelB}，首次推理可能稍慢）...`)
    rb = await runSystem(modelB.replace(/[^a-z0-9]/gi, '').slice(0, 12), layerB)
  } finally {
    layerA.close()
    layerB.close()
    rmSync(base, { recursive: true, force: true })
  }

  for (const r of [ra, rb]) {
    console.log(`\n========== ${r.name} ==========`)
    console.log('查询'.padEnd(34) + '排名  目标相似度  最强干扰  间隔')
    for (const row of r.rows) {
      console.log(
        row.q.slice(0, 32).padEnd(34) +
        (row.rank === null ? '  —  ' : String(row.rank).padStart(3) + '  ') +
        fmt(row.targetScore).padStart(8) + '   ' +
        fmt(row.bestOther).padStart(6) + '  ' +
        fmt(row.margin),
      )
    }
    console.log(`\nHit@1=${r.hit1}/8  Hit@3=${r.hit3}/8  MRR=${r.mrr.toFixed(3)}  无答案控制项 top 相似度=${r.noMatchTop.toFixed(3)}`)
    const avgLat = r.latencies.reduce((a, b) => a + b, 0) / r.latencies.length
    console.log(`平均召回延迟=${avgLat.toFixed(0)}ms/次`)
  }

  console.log('\n========== 对比汇总 ==========')
  console.log(`Hit@1:  哈希 ${ra.hit1}/8  vs  ${rb.name} ${rb.hit1}/8`)
  console.log(`Hit@3:  哈希 ${ra.hit3}/8  vs  ${rb.name} ${rb.hit3}/8`)
  console.log(`MRR:    哈希 ${ra.mrr.toFixed(3)}  vs  ${rb.name} ${rb.mrr.toFixed(3)}`)
  const semRows = ra.rows.slice(0, 7) // 前 7 条为语义换词查询
  const semMarginA = semRows.reduce((s, x) => s + (x.margin ?? 0), 0) / semRows.length
  const semMarginB = rb.rows.slice(0, 7).reduce((s, x) => s + (x.margin ?? 0), 0) / semRows.length
  console.log(`语义查询平均间隔(目标-干扰): 哈希 ${semMarginA.toFixed(3)}  vs  ${rb.name} ${semMarginB.toFixed(3)}`)
}

main().catch((err) => {
  console.error('A/B 测试失败：', err)
  process.exit(1)
})
