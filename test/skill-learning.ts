/**
 * 第十二轮修复固化（技能沉淀链路：触发提质 + merge 契约）：
 *
 * A. kernel.mergeSkill：仅精确同名追加，不做语义模糊匹配，找不到不创建；
 *    追加按行去重、与 learnSkill 共用 appendToSkill 同一合并口径。
 * B. hooks 触发启发式（真实 Cordis 宿主）：
 *    - 单轮 bigram（read→read）不再提示；
 *    - 单工具连击（edit→edit→edit）与元工具（todo_write）序列不提示；
 *    - 跨轮重复的 3 元组（≥2 种工具）第 2 次出现才提示，同会话去重；
 *    - repair 放宽到同会话（失败隔轮后成功也认），同轮先败后成仍认；
 *    - session/flush 后去重账与轨迹清零。
 * C. laap_skill 工具契约：action enum 含 learn/list/merge；
 *    merge 不存在名字给引导回执且零写入；learn 后 merge 同名追加、list 仍 1 条。
 *
 * 运行：node --experimental-strip-types test/skill-learning.ts
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { EmbedAsyncFn } from '../src/core/memory/embed.ts'
import { createKernel, silentLogger, statePath } from '../src/core/index.ts'
import * as laapService from '../src/adapters/cordis/service-plugin.ts'
import * as laapHooks from '../src/adapters/cordis/hooks.ts'
import * as laapTools from '../src/adapters/cordis/tools.ts'
import { skillHints } from '../src/adapters/cordis/hooks.ts'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`断言失败: ${msg}`)
  passed++
  console.log(`✔ ${msg}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rm = (p: string) => rmSync(p, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })

// 确定性稀疏哈希嵌入：不同文本近似正交，避免不相关技能被语义去重误并
const hashEmbed: EmbedAsyncFn = async (texts: string[]) =>
  texts.map((t) => {
    const v = new Array(8).fill(0)
    let h = 0
    for (let i = 0; i < t.length; i++) { h = (Math.imul(h, 31) + t.charCodeAt(i)) >>> 0; v[h % 8] += 1 }
    const norm = Math.hypot(...v) || 1
    return v.map((x) => x / norm)
  })

const now = Date.now()
const DB_K = `${tmpdir()}/laap-skill-k-${now}`
const DB_H = `${tmpdir()}/laap-skill-h-${now}`
const ALL_DBS = [DB_K, DB_H]

let exitCode = 0
try {
  // ══ A. kernel.mergeSkill ════════════════════════════════════════
  const k = createKernel(
    { logger: silentLogger },
    { dbPath: DB_K, heartbeatMs: 0, consolidateEvery: 9999, embed: hashEmbed, embedDim: 8 },
  )

  const nf = await k.mergeSkill('不存在的技能XYZ', '1. 不应被写入的要点')
  assert(nf.action === 'not_found' && k.memory.listSkills().length === 0,
    'merge 未命中：not_found 且不隐式创建（procedural 仍为 0）')

  const created = await k.learnSkill('三步工作法', '1. 做甲\n2. 做乙\n3. 做丙')
  const merged = await k.mergeSkill('三步工作法', '2. 做乙\n4. 做丁')
  assert(
    created.action === 'created' && merged.action === 'updated' && merged.steps === 4 &&
      k.memory.listSkills()[0].text.includes('做甲') && k.memory.listSkills()[0].text.includes('做丁'),
    'merge 同名：新要点追加（4 条）、旧要点保留、重复要点不膨胀')

  const again = await k.mergeSkill('三步工作法', '4. 做丁')
  assert(again.action === 'unchanged' && again.steps === 4, 'merge 全重复要点：unchanged 且条数不增')

  const otherName = await k.mergeSkill('三步工作法变体', '9. 完全是另一条技能的要点')
  assert(otherName.action === 'not_found', 'merge 仅认精确同名：语义/名称近似不做模糊合并（可预测，防误并）')
  k.dispose()
  await sleep(150)

  // ══ B. hooks 触发启发式（真实 Cordis 宿主）═════════════════════
  const ctx = new Context()
  const fiber = await ctx.plugin(laapService, { dbPath: DB_H, heartbeatMs: 9999, consolidateEvery: 9999, episodicCap: 0 })
  await ctx.plugin(laapHooks)
  skillHints.resetSession()

  const turnStart = () => ctx.emit('session/event', {} as any, { type: 'turn/start' } as any)
  const turnEnd = () => ctx.emit('session/event', {} as any, { type: 'turn/end' } as any)
  const ok = (name: string) => ctx.emit('tools/result', { name } as any, {} as any)
  const bad = (name: string) => ctx.emit('tools/result', { name } as any, { error: { message: 'boom' } } as any)
  const drain = () => skillHints.take()

  // B5 旧 bigram 噪声：单轮 read→read 不再提示
  turnStart(); ok('read'); ok('read'); turnEnd()
  assert(drain().length === 0, '单轮 read→read（旧 bigram 呼吸噪声）：不提示')

  // B6 单工具连击 + 元工具：两轮重复 edit×3 夹杂 todo_write → 0
  for (let i = 0; i < 2; i++) { turnStart(); ok('edit'); ok('edit'); ok('edit'); ok('todo_write'); turnEnd() }
  assert(drain().length === 0, 'edit→edit→edit 单工具连击 / todo_write 元工具序列：不提示')

  // B7 跨轮 3 元组第 2 次出现：恰好 1 条 repeat，sequence 长 3
  turnStart(); ok('read'); ok('write'); ok('edit'); turnEnd()
  assert(drain().length === 0, '3 元组首次出现：只计数不提示')
  turnStart(); ok('read'); ok('write'); ok('edit'); turnEnd()
  const h7 = drain()
  assert(
    h7.length === 1 && h7[0].kind === 'repeat' &&
      h7[0].sequence?.length === 3 && h7[0].sequence!.join('→') === 'read→write→edit',
    '跨轮第 2 次出现 read→write→edit：1 条 repeat 提醒，序列长 3')

  // B8 第三次重复：会话去重，仍 0 新增
  turnStart(); ok('read'); ok('write'); ok('edit'); turnEnd()
  assert(drain().length === 0, '同会话第 3 次重复：去重不重复提示')

  // B9a repair 跨轮：第 1 轮 shell 失败（夹杂别的成功），第 2 轮 shell 成功
  turnStart(); bad('shell'); ok('read'); turnEnd()
  turnStart(); ok('shell'); turnEnd()
  const h9 = drain()
  assert(h9.length === 1 && h9[0].kind === 'repair' && h9[0].tool === 'shell',
    '同工具失败隔轮后成功：repair 提示（不再要求同轮）')

  // B9b repair 同轮先败后成仍然成立
  turnStart(); bad('glob'); ok('write'); ok('glob'); turnEnd()
  const h9b = drain()
  assert(h9b.length === 1 && h9b[0].kind === 'repair' && h9b[0].tool === 'glob',
    '同轮内同工具先失败后成功：repair 提示（旧行为不回归）')

  // B10 flush 后去重账与轨迹清零：同一模式可再次提示
  ctx.emit('session/flush', {} as any, {} as any)
  await sleep(50)
  turnStart()
  ok('read'); ok('write'); ok('edit')
  ok('read'); ok('write'); ok('edit') // 清空后同轮内第 2 次即达 REPEAT_TIMES
  turnEnd()
  const h10 = drain()
  assert(h10.length === 1 && h10[0].kind === 'repeat', 'session/flush 后轨迹与去重账清零，同模式可再次提示')

  // ══ C. laap_skill 工具契约（桩 tools 服务捕获注册体）═══════════
  class StubTools extends Service {
    static provide = 'tools'
    private defs = new Map<string, any>()
    constructor(ctx: Context) { super(ctx, 'tools') }
    register(def: any) { this.defs.set(def.name, def); return () => { this.defs.delete(def.name) } }
    get(name: string) { return this.defs.get(name) }
  }
  await ctx.plugin(StubTools)
  await ctx.plugin(laapTools)
  const tool = (ctx as any).tools.get('laap_skill')

  assert(
    ['learn', 'list', 'merge'].every((a) => tool.parameters.properties.action.enum.includes(a)),
    "schema 契约：action enum = learn/list/merge（merge 不再被参数校验拒绝）")

  const rNf = await tool.execute({ action: 'merge', name: '契约不存在技能', howto: '1. 不该写入' })
  assert(
    String(rNf.narrative).includes('未找到同名技能') && String(rNf.narrative).includes('未做任何写入') &&
      ctx.laap.memory.listSkills().length === 0,
    'merge 不存在名字：引导回执（先 list / 改用 learn）且零写入')

  await tool.execute({ action: 'learn', name: '契约测试法', howto: '1. 甲\n2. 乙' })
  const rUp = await tool.execute({ action: 'merge', name: '契约测试法', howto: '3. 丙' })
  const rList = await tool.execute({ action: 'list' })
  assert(
    String(rUp.narrative).includes('合并') &&
      ctx.laap.memory.listSkills().length === 1 &&
      String(rList.narrative).includes('契约测试法') && String(rList.narrative).includes('丙'),
    'learn→merge→list 全链路：合并回执正确、技能不膨胀（仍 1 条）且含新要点')

  skillHints.resetSession()
  await fiber.dispose()
  await sleep(300)

  console.log(`\n技能沉淀链路测试全部通过：${passed} 条断言`)
} catch (err) {
  console.error(err)
  exitCode = 1
} finally {
  for (const d of ALL_DBS) {
    try { rm(d) } catch { /* mmap 残留句柄时忽略 */ }
    try { rm(statePath(d)) } catch { /* ignore */ }
  }
  process.exit(exitCode)
}
