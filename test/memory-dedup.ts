/**
 * 语义记忆去重：provider 感知阈值 + laap_remember 合并回执
 *
 * - store 层：去重阈值可注入（hash 默认 0.92；神经嵌入标定 0.75）
 * - kernel 接线：LaapKernelOptions.semanticDedupThreshold 透传到 MemoryLayer
 * - 工具层：laap_remember 发生合并时回执必须透出被合并的旧记忆 id
 *   （旧实现丢弃 store 返回的 deduplicated，模型连写三次同义记忆会误判「存了三份」）
 *
 * 用确定性合成 4 维向量精确控制余弦相似度，不依赖 Ollama。
 * 运行：node --experimental-strip-types test/memory-dedup.ts
 */
import { Context } from '@deepseek-ai/cordis'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { MemoryLayer } from '../src/core/memory/store.ts'
import type { EmbedAsyncFn } from '../src/core/memory/embed.ts'
import { createKernel, silentLogger } from '../src/core/index.ts'
import * as laapTools from '../src/adapters/cordis/tools.ts'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`断言失败: ${msg}`)
  passed++
  console.log(`✔ ${msg}`)
}
const docCount = (col: MemoryLayer) => {
  let n = 0
  for (const _ of (col as any).col.iterDocsSync({})) n++
  return n
}

// ── 合成嵌入：A=[1,0,0,0]；A′ 与 A 余弦 0.78（同义改写）；B 与 A 余弦 0.60（不同事实）──
const A = [1, 0, 0, 0]
const Ap = [0.78, Math.sqrt(1 - 0.78 * 0.78), 0, 0]
const B = [0.6, 0, 0.8, 0]
const O = [0, 0, 0, 1]
const synthEmbed: EmbedAsyncFn = async (texts: string[]) =>
  texts.map((t) => (t === 'A' ? A : t === 'AP' ? Ap : t === 'B' ? B : O))

const now = Date.now()
const DB1 = `${tmpdir()}/laap-dedup-default-${now}`
const DB2 = `${tmpdir()}/laap-dedup-tuned-${now}`
const DB3 = `${tmpdir()}/laap-dedup-kernel-${now}`
const mk = (text: string) => ({ id: `mem-${Math.random().toString(36).slice(2, 8)}`, kind: 'semantic' as const, text, ts: Date.now(), salience: 0.8 })

try {
  // ── I. 默认阈值 0.92（哈希口径）：0.78 的改写不合并，完全重复才合并 ──
  const hashish = new MemoryLayer(DB1, synthEmbed, 4)
  const r1 = await hashish.remember(mk('A'))
  const r2 = await hashish.remember(mk('AP'))
  assert(r2.deduplicated === undefined, '默认 0.92：余弦 0.78 的改写不视为重复（2 条共存）')
  assert(docCount(hashish) === 2, '默认 0.92：库内 2 条')
  const r3 = await hashish.remember(mk('A'))
  assert(r3.deduplicated === r1.id, '默认 0.92：完全重复（余弦 1.0）删旧写新')
  assert(docCount(hashish) === 2, '默认 0.92：合并后总数仍为 2')
  hashish.close()

  // 显式传 0（未配置语义）必须回退默认 0.92，而不是让任意写入都误判重复
  const DB1b = `${tmpdir()}/laap-dedup-zero-${now}`
  const zeroish = new MemoryLayer(DB1b, synthEmbed, 4, { semanticDedupThreshold: 0 })
  const z1 = await zeroish.remember(mk('A'))
  const z2 = await zeroish.remember(mk('B'))
  assert(z2.deduplicated === undefined && docCount(zeroish) === 2, '显式阈值 0 回退默认口径（不误合并）')
  void z1
  zeroish.close()
  rmSync(DB1b, { recursive: true, force: true })

  // ── II. 神经嵌入阈值 0.75（bge-m3 实测空档：同义 0.79~0.95 / 异义 ≤0.72）──
  const neural = new MemoryLayer(DB2, synthEmbed, 4, { semanticDedupThreshold: 0.75 })
  const n1 = await neural.remember(mk('A'))
  const n2 = await neural.remember(mk('AP'))
  assert(n2.deduplicated === n1.id, '阈值 0.75：余弦 0.78 的同义改写被合并')
  assert(docCount(neural) === 1, '阈值 0.75：库内仅 1 条（语义层不膨胀）')
  const n3 = await neural.remember(mk('B'))
  assert(n3.deduplicated === undefined, '阈值 0.75：余弦 0.60 的不同事实保留')
  assert(docCount(neural) === 2, '阈值 0.75：库内 2 条')

  // 情景记忆永不参与语义去重（事件流允许重复）
  const e1 = await neural.remember({ id: 'ep-1', kind: 'episodic', text: 'A', ts: Date.now(), salience: 0.3 })
  const e2 = await neural.remember({ id: 'ep-2', kind: 'episodic', text: 'A', ts: Date.now(), salience: 0.3 })
  assert(e1.deduplicated === undefined && e2.deduplicated === undefined && docCount(neural) === 4,
    '情景记忆不参与去重（即使文本完全相同）')
  neural.close()

  // ── III. kernel 接线：opts.semanticDedupThreshold 透传 ──
  const k = createKernel(
    { logger: silentLogger },
    { dbPath: DB3, heartbeatMs: 0, consolidateEvery: 9999, embed: synthEmbed, embedDim: 4, semanticDedupThreshold: 0.75 },
  )
  const k1 = await k.memory.remember(mk('A'))
  const k2 = await k.memory.remember(mk('AP'))
  assert(k2.deduplicated === k1.id, 'LaapKernel 注入阈值 0.75 后同义改写合并生效')
  k.dispose()
  await new Promise((r) => setTimeout(r, 200))

  // ── IV. laap_remember 回执：合并时必须透出旧 id（桩宿主，不依赖 dsh-tools 服务）──
  const buildStubCtx = async (rememberFn: (doc: unknown) => Promise<{ id: string; deduplicated?: string }>) => {
    const captured: any[] = []
    const ctx = new Context()
    ctx.plugin({
      name: 'laap-stub-services',
      apply(c: any) {
        c.provide('laap')
        c.laap = { memory: { remember: rememberFn } }
        c.provide('tools')
        c.tools = { register: (t: any) => captured.push(t) }
      },
    })
    await ctx.plugin(laapTools as any)
    return captured.find((t) => t.name === 'laap_remember')
  }
  // IV-a：store 报告合并 → 回执必须包含旧 id
  const toolMerged = await buildStubCtx(async () => ({ id: 'mem-new-xyz', deduplicated: 'mem-old-abc' }))
  const outMerged = await toolMerged.execute({ text: '喜欢简洁代码', kind: 'semantic' })
  assert(/合并旧记忆/.test(outMerged.narrative) && outMerged.narrative.includes('mem-old-abc'),
    '合并发生：回执透出被合并的旧记忆 id')
  // IV-b：无合并 → 回执不含合并措辞
  const toolFresh = await buildStubCtx(async () => ({ id: 'mem-fresh-1' }))
  const outFresh = await toolFresh.execute({ text: '全新事实', kind: 'semantic' })
  assert(!/合并旧记忆/.test(outFresh.narrative) && outFresh.narrative.includes('mem-fresh-1'),
    '无合并：回执为普通写入成功，不含合并措辞')

  console.log(`\n记忆去重测试全部通过：${passed} 条断言`)
} finally {
  for (const d of [DB1, DB2, DB3]) {
    rmSync(d, { recursive: true, force: true })
    rmSync(`${d}.consciousness.json`, { force: true })
  }
  process.exit(0)
}
