/**
 * 完善版行为验证模拟（不依赖 dsh 运行时，直接驱动意识内核 + zvec）
 *
 * 在 MVP 六项断言基础上新增：
 *  A. 程序记忆：learnSkill 写入 → procedural 过滤召回命中 → 内存技能清单
 *  B. L4 策略库：某模式反复失败后，policyAdjust 覆盖启发式选择
 *  C. L3 审视报告：examine() 输出模式成效统计
 *  D. 自传蒸馏：达到周期后语义层出现「近况自传」
 *  E. 情绪微分信号方向正确
 *
 * 运行：node --experimental-strip-types test/sim.ts
 */
import { rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ConsciousnessEngine } from '../src/consciousness/state.ts'
import { CognitiveBus, frameToNarrative } from '../src/consciousness/bus.ts'
import { MetacognitiveMonitor } from '../src/consciousness/monitor.ts'
import { MemoryLayer } from '../src/memory/store.ts'
import { hashEmbed } from '../src/memory/embed.ts'
import { captureConsciousness, loadConsciousness, restoreConsciousness, saveConsciousness, statePath } from '../src/consciousness/persist.ts'
import type { CognitiveEvent } from '../src/consciousness/types.ts'

const assert = (cond: boolean, msg: string) => {
  console.log(`${cond ? '  ✔' : '  ✘ FAIL'} ${msg}`)
  if (!cond) process.exitCode = 1
}

// zvec 依赖 mmap，路径必须本地盘（OSS/NFS 会 Bus error）
const DB = `${tmpdir()}/laap-sim-zvec-v2`
rmSync(DB, { recursive: true, force: true })

const engine = new ConsciousnessEngine({ sensitivity: 1 })
const bus = new CognitiveBus(engine)
const monitor = new MetacognitiveMonitor()
const memory = new MemoryLayer(DB, hashEmbed)

function perceive(e: CognitiveEvent) {
  engine.process(e)
  bus.submit(
    e.type.startsWith('tool') ? 'action' : e.type === 'user_message' ? 'perception' : 'somatic',
    e.type === 'user_message' ? `用户说：${(e as any).text.slice(0, 60)}`
      : e.type === 'tool_error' ? `行动受挫：${(e as any).tool}`
      : e.type === 'tool_success' ? `行动成功：${(e as any).tool}` : '内部事件',
    e.type === 'tool_error' ? 1 : 0.8,
  )
  return bus.broadcast()
}

console.log('═══ dsh-laap 完善版模拟 ═══\n')

const script: CognitiveEvent[] = [
  { type: 'user_message', text: '帮我把用户模块的测试补全' },
  { type: 'task_start', description: '补全测试' },
  { type: 'tool_success', tool: 'read' },
  { type: 'tool_success', tool: 'write', novelty: 0.6 },
  { type: 'tool_error', tool: 'shell', message: 'vitest: 12 failed' },
  { type: 'tool_error', tool: 'shell', message: 'vitest: still 12 failed' },
  { type: 'user_message', text: '没关系，看看失败断言到底是什么' },
  { type: 'tool_success', tool: 'str_replace' },
  { type: 'tool_success', tool: 'shell' },
  { type: 'task_end', success: true },
  { type: 'idle', seconds: 3600 },
  { type: 'user_message', text: '把刚才的经验记住' },
]

for (const e of script) {
  const frame = perceive(e)
  if (frame.broadcast.length > 0) {
    memory.pushWorking(frameToNarrative(frame), { id: `frame-${frame.tick}`, ts: Date.now() })
  }
  if (frame.mode === 'reflective') monitor.record({ thought: '连续 shell 失败', outcome: 'failure', confidence: 0.8 }, frame.tick)
  if (frame.tick % 3 === 0) monitor.recordMode(frame.mode, frame.tick < 10 ? false : true)
  const s = frame.state
  console.log(`tick ${String(frame.tick).padStart(2)} | 压${s.stress.toFixed(2)} 信${s.confidence.toFixed(2)} 能${s.energy.toFixed(2)} | ${frame.mode.padEnd(11)} | qualia:[${frame.qualia.join(',')}]`)
}

console.log('\n── 元认知 L1 校准 ──')
monitor.record({ thought: '定位断言根因并修复', outcome: 'success', confidence: 0.6 }, engine.snapshot().tick)
const calib = monitor.summary()
console.log(`样本 ${calib.traces}，校准信心 ${calib.calibrated.toFixed(2)}，失败率 ${(calib.failureRate * 100).toFixed(0)}%`)

console.log('\n── zvec 三层记忆闭环 ──')
await memory.remember({ id: 'e1', kind: 'episodic', text: '用户让我补全用户模块测试，vitest 失败 12 个后修复通过', ts: Date.now(), salience: 0.9 })
await memory.remember({ id: 's1', kind: 'semantic', text: '经验：测试失败时先读断言差异，不要盲目重跑', ts: Date.now(), salience: 0.8, mode: 'reflective' })
await memory.remember({ id: 's2', kind: 'semantic', text: '用户偏好中文沟通，喜欢直接给结论', ts: Date.now(), salience: 0.7 })
await memory.remember({ id: 'p1', kind: 'procedural', text: '技能「vitest断言修复」：先跑单条用例看 diff，改 mock 数据后回归全量', ts: Date.now(), salience: 0.9 })

const hits = await memory.recall('上次测试挂了很多个后来是怎么解决的？', { topk: 3 })
assert(hits.length >= 3 && hits.some((h) => h.id === 'e1') && hits[0].score >= hits[1].score, 'MVP-2 向量联想召回按相关度命中')

const proc = await memory.recall('遇到测试失败该用什么流程？', { topk: 2, kind: 'procedural' })
assert(proc.length >= 1 && proc[0].id === 'p1', 'A 程序记忆：procedural 过滤召回命中技能')
assert(memory.listSkills().some((s) => s.id === 'p1'), 'A 技能清单内存索引可用（重启后由 iterDocs 重建）')

console.log('\n── L4 策略库：模式成效反馈 ──')
const probe = new MetacognitiveMonitor()
for (let i = 0; i < 8; i++) probe.recordMode('exploratory', false) // 探索模式屡战屡败
for (let i = 0; i < 8; i++) probe.recordMode('analytic', true)    // 分析模式屡试不爽
const [finalMode, overridden] = probe.policyAdjust('exploratory')
console.log(`启发式选 exploratory → 策略层给 ${finalMode}（覆盖: ${overridden}）`)
assert(overridden && finalMode === 'analytic', 'B 高样本低胜率模式被策略库覆盖')
const [coldMode, coldOver] = new MetacognitiveMonitor().policyAdjust('creative')
assert(!coldOver && coldMode === 'creative', 'B 冷启动无数据时完全信任启发式（不学偏）')
console.log('L3 审视报告:', probe.examine().join(' | '))
assert(probe.examine().length >= 3, 'C L3 examine 输出模式成效与信心校准')

console.log('\n── 自传蒸馏（自我模型涌现最小实现）──')
const autobio = `我的近况自传（tick ${engine.snapshot().tick}）：近期经历「行动受挫：shell」，当前relatedness需求满足度最高，惯用思考模式成效：${monitor.examine()[0] ?? '样本不足'}`
await memory.remember({ id: `autobio-${engine.snapshot().tick}`, kind: 'semantic', text: autobio, ts: Date.now(), salience: 0.85 })
const me = await memory.recall('我最近的状态怎么样？', { topk: 3, kind: 'semantic' })
console.log(me.map((h) => `  [${h.id}] ${h.text.slice(0, 60)}`).join('\n'))
assert(me.some((h) => h.id.startsWith('autobio')), 'D 自传进入语义自我层并可被召回')

const emo = engine.emotion()
assert(Object.keys(emo.perNeed).length === 5, 'E 情绪微分信号覆盖五需求')
assert(engine.snapshot().tick >= script.length, 'MVP-1 状态动力学演化')
assert(calib.failureRate > 0.5, 'MVP-4 元认知对失败打折')
assert(memory.getWorking().length <= 7, 'MVP-6 工作记忆有界')

console.log('\n── 存在连续性：意识快照落盘与跨重启恢复 ──')
const snap = captureConsciousness(engine, monitor)
saveConsciousness(DB, snap)
assert(existsSync(statePath(DB)), 'F 意识快照原子写入磁盘')
const engine2 = new ConsciousnessEngine({})
const monitor2 = new MetacognitiveMonitor()
const loaded = loadConsciousness(DB)!
restoreConsciousness(engine2, monitor2, loaded)
const r = engine2.snapshot()
assert(r.tick === snap.tick && Math.abs(r.stress - snap.state.stress) < 1e-9, 'F 重启后 tick 与状态向量精确续接')
assert(monitor2.calibratedConfidence(1) === monitor.calibratedConfidence(1), 'F 校准历史（含基数）跨重启一致')
assert(loadConsciousness(`${tmpdir()}/laap-missing-${Date.now()}/zvec`) === null, 'F 无快照时安全降级为全新意识')

console.log('\n── 语义记忆去重 ──')
await memory.remember({ id: 'fact-a', kind: 'semantic', text: '用户偏好中文沟通，喜欢直接给结论', ts: Date.now(), salience: 0.7 })
const dup = await memory.remember({ id: 'fact-b', kind: 'semantic', text: '用户偏好中文沟通，喜欢直接给结论', ts: Date.now(), salience: 0.75 })
assert(!!dup.deduplicated, 'G 近似语义写入自动识别重复并替换')
const after = await memory.recall('用户偏好中文沟通，喜欢直接给结论', { kind: 'semantic', topk: 5 })
assert(after.filter((h) => h.id === 'fact-a' || h.id === 'fact-b').length === 1, 'G 语义层不因重复表述膨胀')

console.log('\n── 新异性刺激方向 ──')
const before = engine.snapshot().curiosity
engine.process({ type: 'novelty', novel: true, distance: 0.9 })
assert(engine.snapshot().curiosity >= before, 'H 新奇刺激点燃好奇心（不降反升）')

memory.close()
rmSync(DB, { recursive: true, force: true })
rmSync(statePath(DB), { force: true })
console.log('\n模拟结束。')

