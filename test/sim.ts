/**
 * 完善版行为验证模拟（不依赖 dsh 运行时，直接驱动框架无关的 LaapKernel）
 *
 * 解耦后本测试直接跑生产里真正使用的内核管线（src/core/kernel.ts）：
 * perceive 感知流水线、新异性检测、自动情景归档、自传蒸馏、工作记忆沉淀、
 * 帧历史环与意识快照——而非在测试里手工重写一遍。
 *
 * 覆盖断言：
 *  A. 程序记忆：learnSkill 写入 → procedural 过滤召回命中 → 内存技能清单
 *  B. L4 策略库：某模式反复失败后，policyAdjust 覆盖启发式选择
 *  C. L3 审视报告：examine() 输出模式成效统计
 *  D. 自传蒸馏：达到周期后语义层自动出现「近况自传」
 *  E. 情绪微分信号方向正确
 *  F. 存在连续性：意识快照落盘与跨重启恢复
 *  G. 语义记忆近似去重
 *  H. 新异性刺激方向
 *
 * 运行：node --experimental-strip-types test/sim.ts
 */
import { rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  createKernel,
  silentLogger,
  ConsciousnessEngine,
  MetacognitiveMonitor,
  captureConsciousness,
  loadConsciousness,
  restoreConsciousness,
  saveConsciousness,
  statePath,
} from '../src/core/index.ts'
import type { CognitiveEvent } from '../src/core/index.ts'

const assert = (cond: boolean, msg: string) => {
  console.log(`${cond ? '  ✔' : '  ✘ FAIL'} ${msg}`)
  if (!cond) process.exitCode = 1
}

// zvec 依赖 mmap，路径必须本地盘（OSS/NFS 会 Bus error）
const DB = `${tmpdir()}/laap-sim-zvec-v3`
rmSync(DB, { recursive: true, force: true })
rmSync(statePath(DB), { force: true })

// 通过平台适配器工厂构造内核：Node 默认适配器（console/全局定时器/zvec）+ 静默日志；
// 关后台心跳（heartbeatMs:0）保证确定性；缩短蒸馏周期以跑到自动自传
const kernel = createKernel(
  { logger: silentLogger },
  { dbPath: DB, heartbeatMs: 0, consolidateEvery: 6, noveltyThreshold: 0.45 },
)
const { engine, monitor, memory } = kernel

function perceive(e: CognitiveEvent) {
  const frame = kernel.perceive(e)
  // 进入 reflective 模式时记录一条失败思维轨迹（喂 L1 校准；record() 在宿主里由
  // hooks/reflect 触发，内核自身只产 recordMode 模式成效，故此处显式造失败样本）
  if (frame.mode === 'reflective') {
    monitor.record({ thought: '连续 shell 失败', outcome: 'failure', confidence: 0.8 }, frame.tick)
  }
  return frame
}

console.log('═══ dsh-laap 完善版模拟（真实 LaapKernel 管线）═══\n')

const script: CognitiveEvent[] = [
  { type: 'user_message', text: '帮我把用户模块的测试补全' },
  { type: 'task_start', description: '补全测试' },
  { type: 'tool_success', tool: 'read' },
  { type: 'tool_success', tool: 'write' },
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
    const s = frame.state
    console.log(`tick ${String(frame.tick).padStart(2)} | 压${s.stress.toFixed(2)} 信${s.confidence.toFixed(2)} 能${s.energy.toFixed(2)} | ${frame.mode.padEnd(11)} | qualia:[${frame.qualia.join(',')}]`)
  }
}

// 等内核 fire-and-forget 的异步写入（新异性检索 / 自动情景归档 / 自传蒸馏）落库
await new Promise((r) => setTimeout(r, 400))

console.log('\n── 元认知 L1 校准 ──')
monitor.record({ thought: '定位断言根因并修复', outcome: 'success', confidence: 0.6 }, engine.snapshot().tick)
const calib = monitor.summary()
console.log(`样本 ${calib.traces}，校准信心 ${calib.calibrated.toFixed(2)}，失败率 ${(calib.failureRate * 100).toFixed(0)}%`)

console.log('\n── zvec 三层记忆闭环 ──')
await memory.remember({ id: 'e1', kind: 'episodic', text: '用户让我补全用户模块测试，vitest 失败 12 个后修复通过', ts: Date.now(), salience: 0.9 })
await memory.remember({ id: 's1', kind: 'semantic', text: '经验：测试失败时先读断言差异，不要盲目重跑', ts: Date.now(), salience: 0.8, mode: 'reflective' })
await memory.remember({ id: 's2', kind: 'semantic', text: '用户偏好中文沟通，喜欢直接给结论', ts: Date.now(), salience: 0.7 })
// learnSkill 走内核（程序记忆 id 为名称哈希，故 A 断言只看命中不看具体 id）
await kernel.learnSkill('vitest断言修复', '先跑单条用例看 diff，改 mock 数据后回归全量')

const hits = await memory.recall('上次测试挂了很多个后来是怎么解决的？', { topk: 3 })
assert(hits.length >= 3 && hits.some((h) => h.id === 'e1') && hits[0].score >= hits[1].score, 'MVP-2 向量联想召回按相关度命中')

const proc = await kernel.matchSkills('遇到测试失败该用什么流程？', 2)
assert(proc.length >= 1 && proc[0].kind === 'procedural', 'A 程序记忆：procedural 过滤召回命中技能')
assert(memory.listSkills().length >= 1, 'A 技能清单内存索引可用（重启后由 iterDocs 重建）')

console.log('\n── L4 策略库：模式成效反馈 ──')
const probe = new MetacognitiveMonitor()
for (let i = 0; i < 8; i++) probe.recordMode('exploratory', false) // 探索模式屡战屡败
for (let i = 0; i < 8; i++) probe.recordMode('analytic', true)    // 分析模式屡试不爽
const [finalMode, overridden] = probe.policyAdjust('exploratory')
console.log(`启发式选 exploratory → 策略层给 ${finalMode}（覆盖: ${overridden}）`)
assert(overridden && finalMode === 'analytic', 'B 高样本低胜率模式被策略库覆盖')
const [, coldOver] = new MetacognitiveMonitor().policyAdjust('creative')
assert(!coldOver, 'B 冷启动无数据时完全信任启发式（不学偏）')
console.log('L3 审视报告:', probe.examine().join(' | '))
assert(probe.examine().length >= 3, 'C L3 examine 输出模式成效与信心校准')

console.log('\n── 自传蒸馏（自我模型涌现最小实现）──')
const me = await memory.recall('我的近况自传', { topk: 5, kind: 'semantic' })
console.log(me.map((h) => `  [${h.id}] ${h.text.slice(0, 60)}`).join('\n'))
assert(me.some((h) => h.id.startsWith('autobio')), 'D 内核达到周期后自动蒸馏自传进入语义自我层并可被召回')

const emo = engine.emotion()
assert(Object.keys(emo.perNeed).length === 5, 'E 情绪微分信号覆盖五需求')
assert(engine.snapshot().tick >= script.length, 'MVP-1 状态动力学演化')
assert(calib.failureRate > 0.5, 'MVP-4 元认知对失败打折')
assert(memory.getWorking().length <= 7, 'MVP-6 工作记忆有界（内核自动沉淀）')

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
kernel.perceive({ type: 'novelty', novel: true, distance: 0.9 })
assert(engine.snapshot().curiosity >= before, 'H 新奇刺激点燃好奇心（不降反升）')

console.log('\n── UI 快照可序列化（rpc 通道只传 JSON）──')
const ui = kernel.uiSnapshot()
const uiJson = JSON.parse(JSON.stringify(ui))
assert(Array.isArray(uiJson.frameLog) && uiJson.state && uiJson.drives && uiJson.emotion, 'uiSnapshot 纯 JSON 可序列化且字段完整')

// 内核 dispose：停心跳 + 存快照 + 关 zvec（等价宿主 ctx.effect 卸载）
kernel.dispose()
rmSync(DB, { recursive: true, force: true })
rmSync(statePath(DB), { force: true })
console.log('\n模拟结束。')
