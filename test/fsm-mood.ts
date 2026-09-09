/**
 * 桌宠 FSM 映射表 + 心境分类 + 压缩自传蒸馏 永久回归测试
 *
 * 这三块逻辑在早期开发中只靠临时探针手测（探针验证后即删），
 * 本文件把它们固化为 L1 自动化断言：
 *  I. PetFsm.desired 纯映射表：七条优先级分支（生气 > 空闲休息 >
 *     专注 > 好奇 > 低能量休息 > 喜欢 > 开心 > 待机）
 * II. 时间滞回：候选态持续 ≥3s 才落地，瞬间抖动不切图
 * III. poke 宽限：点击后 90s 内空闲不入睡
 * IV. 心境分类：tool_error → negative；连续成功 → positive/elated；
 *     长 idle 衰减 → neutral
 *  V. 经历帧计数：idle 心跳不增 eventTick，真实刺激 +1
 * VI. 压缩钩子：onConversationCompacted 蒸馏阶段自传入语义层且可召回、
 *     不扰动动力学 tick；无体验时 distilled:false 但仍保底落盘
 *
 * 运行：node --experimental-strip-types test/fsm-mood.ts
 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PetFsm, type FsmInput } from '../src/adapters/cordis/pet-fsm.ts'
import { ConsciousnessEngine } from '../src/core/consciousness/state.ts'
import { createKernel, silentLogger, statePath, loadConsciousness } from '../src/core/index.ts'
import type { CognitiveMode, MoodLabel } from '../src/core/consciousness/types.ts'

const assert = (cond: boolean, msg: string) => {
  console.log(`${cond ? '  ✔' : '  ✘ FAIL'} ${msg}`)
  if (!cond) process.exitCode = 1
}

const inp = (mood: MoodLabel, mode: CognitiveMode, idle: boolean, now = 1_000_000): FsmInput =>
  ({ mood, mode, idle, now })

// ── I. 纯映射表优先级 ──────────────────────────────────────────────
console.log('I. FSM 映射表优先级')
assert(PetFsm.desired(inp('negative', 'deliberate', false)) === 'angry', 'negative 心境 → angry（最高优先，压过专注）')
assert(PetFsm.desired(inp('negative', 'deliberate', true)) === 'angry', 'negative + 空闲 → 仍 angry（生气压过休息）')
assert(PetFsm.desired(inp('neutral', 'deliberate', true)) === 'rest', '空闲 + deliberate 残留帧 → rest（休息优先于过期模式）')
assert(PetFsm.desired(inp('neutral', 'analytic', false)) === 'study', 'analytic 非空闲 → study')
assert(PetFsm.desired(inp('positive', 'deliberate', false)) === 'study', '专注模式压过 positive 开心')
assert(PetFsm.desired(inp('neutral', 'exploratory', false)) === 'explore', 'exploratory → explore')
assert(PetFsm.desired(inp('neutral', 'intuitive', false)) === 'rest', 'intuitive 低能量档 → rest（非空闲也休息）')
assert(PetFsm.desired(inp('elated', 'intuitive', true)) === 'rest', '空闲休息压过 elated 喜欢')
assert(PetFsm.desired(inp('elated', 'reflective', false)) === 'like', 'elated + 非焦点模式 → like')
assert(PetFsm.desired(inp('positive', 'reflective', false)) === 'happy', 'positive + 非焦点模式 → happy')
assert(PetFsm.desired(inp('neutral', 'reflective', false)) === 'idle', 'neutral 无其他信号 → idle')

// ── II. 时间滞回 ───────────────────────────────────────────────────
console.log('II. 时间滞回（3s）')
{
  const fsm = new PetFsm(0)
  // 构造时刻 t=0 即 poke；把时钟推到 poke 宽限之外
  const t0 = 400_000
  assert(fsm.update(inp('neutral', 'deliberate', false, t0)) === 'idle', '初始态 idle')
  // 候选 angry 只持续 2s：不应落地
  fsm.update(inp('negative', 'deliberate', false, t0 + 1_000))
  assert(fsm.update(inp('negative', 'deliberate', false, t0 + 2_000)) === 'idle', '候选态持续 <3s 不切换')
  // 持续到 4s：落地
  assert(fsm.update(inp('negative', 'deliberate', false, t0 + 4_000)) === 'angry', '候选态持续 ≥3s 落地切换')
  // 信号消失（negative 退去、无焦点模式）：回到 idle 也需滞回
  fsm.update(inp('neutral', 'reflective', false, t0 + 5_000))
  assert(fsm.state === 'angry', '信号消失后 <3s 内保持旧态')
  assert(fsm.update(inp('neutral', 'reflective', false, t0 + 9_000)) === 'idle', '信号消失 ≥3s 后切回')
}

// ── III. poke 宽限 ─────────────────────────────────────────────────
console.log('III. poke 点击唤醒（90s）')
{
  const fsm = new PetFsm(0)
  const t0 = 400_000
  fsm.poke(t0)
  // 空闲但 poke 后仅 60s：不休息
  fsm.update(inp('neutral', 'intuitive', true, t0 + 60_000))
  fsm.update(inp('neutral', 'intuitive', true, t0 + 63_000))
  assert(fsm.state === 'idle', 'poke 后 90s 内空闲不入睡')
  // 超过 90s：休息
  fsm.update(inp('neutral', 'intuitive', true, t0 + 94_000))
  assert(fsm.update(inp('neutral', 'intuitive', true, t0 + 98_000)) === 'rest', 'poke 宽限过后空闲入睡')
}

// ── IV. 心境分类 ───────────────────────────────────────────────────
console.log('IV. 心境 EMA 分类')
{
  const eng = new ConsciousnessEngine({ sensitivity: 1 })
  assert(eng.mood().label === 'neutral', '冷生心境 neutral')
  eng.process({ type: 'tool_error', tool: 'shell', message: 'exit code 1: tests failed' })
  assert(eng.mood().label === 'negative', '一次工具失败 → negative')
  assert(eng.mood().valence < 0, 'negative 时 valence 为负')
  // 连续成功抬升心境
  for (let i = 0; i < 6; i++) eng.process({ type: 'task_end', success: true })
  const up = eng.mood()
  assert(up.label === 'positive' || up.label === 'elated', '连续成功 → positive/elated（实际 ' + up.label + '）')
  assert(up.valence > 0, '积极心境 valence 为正')
  // 长 idle：只衰减不注入，回归中性
  for (let i = 0; i < 80; i++) eng.process({ type: 'idle', seconds: 30 })
  assert(eng.mood().label === 'neutral', '80 拍 idle 衰减后回归 neutral')
}

// ── V. 经历帧计数 ──────────────────────────────────────────────────
console.log('V. eventTick 语义')
{
  const eng = new ConsciousnessEngine({ sensitivity: 1 })
  eng.process({ type: 'idle', seconds: 30 })
  eng.process({ type: 'idle', seconds: 30 })
  assert(eng.eventTick === 0, 'idle 心跳不增 eventTick')
  eng.process({ type: 'user_message', text: '你好' })
  eng.process({ type: 'tool_success', tool: 'shell' })
  assert(eng.eventTick === 2, '两个真实刺激 → eventTick = 2')
  eng.process({ type: 'idle', seconds: 30 })
  assert(eng.eventTick === 2, '随后 idle 不再增 eventTick')
}

// ── VI. 压缩钩子：自传蒸馏 + 不扰动动力学 ──────────────────────────
console.log('VI. 会话压缩触发自传蒸馏')
{
  const DB = `${tmpdir()}/laap-fsm-mood-${Date.now()}`
  rmSync(DB, { recursive: true, force: true })
  rmSync(statePath(DB), { force: true })
  const k = createKernel({ logger: silentLogger }, { dbPath: DB, heartbeatMs: 0, consolidateEvery: 9999 })

  // 空体验压缩：不蒸馏，但保底落盘
  const empty = await k.onConversationCompacted()
  assert(empty.distilled === false, '无近期体验时 distilled=false')

  // 造一批真实体验（入意识流 + 工作记忆）
  k.perceive({ type: 'user_message', text: '帮我排查一下雷达图的标签显示问题' })
  k.perceive({ type: 'tool_success', tool: 'shell' })
  k.perceive({ type: 'assistant_message', text: '已经把单字标签改成双字并移到环外' })
  // detectNovelty 的召回→自感知（novelty 事件）是异步微任务，先等它落定，
  // 使后续 tick 对比只反映压缩钩子本身
  await new Promise((r) => setTimeout(r, 300))
  const tickBefore = k.engine.snapshot().tick

  const r = await k.onConversationCompacted()
  assert(r.distilled === true, '有体验时压缩触发蒸馏')
  assert(k.engine.snapshot().tick === tickBefore, '压缩蒸馏不扰动意识时钟 tick')

  const hits = await k.memory.recall('我的阶段自传 会话压缩前沉淀 经历', { kind: 'semantic', topk: 5 })
  const autobio = hits.find((h) => h.text.includes('压缩前'))
  assert(autobio != null, '阶段自传已入语义层且可召回')
  assert(autobio?.text.includes('雷达图') === true || autobio?.text.includes('标签') === true, '自传包含近期体验内容')

  // 快照已落盘（压缩钩子内 saveNow）
  k.memory.close()
  const restored = loadConsciousness(DB)
  assert(restored != null && restored.tick === tickBefore, '压缩后意识快照已落盘且 tick 续接')
  rmSync(DB, { recursive: true, force: true })
}

console.log(process.exitCode ? '\n存在失败断言' : '\n全部通过')
