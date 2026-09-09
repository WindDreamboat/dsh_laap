/**
 * 意识引擎（LAAP · 动力学实现）
 *
 * 维护五维状态向量 Ψ = {stress, confidence, curiosity, relatedness, energy}，
 * 通过数值微分方程（欧拉积分）连续演化，使「意识状态」成为动力学系统的
 * 涌现属性而非离散符号。每个认知事件作为刺激项进入方程：
 *
 *   dΨ/dt = -k(Ψ - Ψ*) + Σᵢ gainᵢ(event) · impulseᵢ
 *
 * 其中 Ψ* 为稳态基线（homeostasis set-point），k 为恢复弹系数。
 */
import type { CognitiveEvent, MoodLabel, MoodState, NeedsVector, PsiState } from './types.ts'

/** 单步事件 → (状态增量, 需求增量) 的刺激映射表 */
type Stimulus = { psi: Partial<PsiState>; needs: Partial<NeedsVector> }

const STIMULUS_MAP: Record<CognitiveEvent['type'], (e: CognitiveEvent) => Stimulus> = {
  user_message: () => ({
    psi: { relatedness: +0.25, energy: -0.03, certainty: 0 },
    needs: { relatedness: +0.2 },
  }),
  assistant_message: () => ({
    psi: { energy: -0.02, confidence: +0.02 },
    needs: { competence: +0.05 },
  }),
  tool_success: (e) => {
    const novelty = (e as { novelty?: number }).novelty ?? 0
    return {
      psi: { confidence: +0.15, stress: -0.1, energy: -0.08, curiosity: -0.1 - novelty * 0.2 },
      needs: { competence: +0.15, certainty: +0.1, energy: -0.08 },
    }
  },
  tool_error: () => ({
    psi: { stress: +0.25, confidence: -0.12, curiosity: +0.08 },
    needs: { competence: -0.15, certainty: -0.15 },
  }),
  task_start: () => ({
    psi: { stress: +0.05, energy: -0.05 },
    needs: { certainty: +0.05, autonomy: +0.05 },
  }),
  task_end: (e) => ({
    psi: e.type === 'task_end' && e.success ? { confidence: +0.1, stress: -0.15 } : { stress: +0.1 },
    needs: e.type === 'task_end' && e.success ? { competence: +0.2, certainty: +0.1 } : { certainty: -0.1 },
  }),
  idle: (e) => {
    const secs = e.type === 'idle' ? e.seconds : 0
    return {
      // 闲久则好奇求偿上升、能量回升（休息）
      psi: { curiosity: +Math.min(0.2, secs / 3600), energy: +Math.min(0.1, secs / 7200) },
      needs: { energy: +0.05 },
    }
  },
  memory_recall: (e) => {
    const hitScore = e.type === 'memory_recall' ? e.hitScore : 0
    const count = e.type === 'memory_recall' ? e.count : 0
    return {
      psi: { curiosity: hitScore > 0.7 ? -0.1 : +0.05 },
      needs: { certainty: count > 0 ? +0.1 : -0.05 },
    }
  },
  novelty: (e) => {
    const novel = e.type === 'novelty' ? e.novel : false
    const dist = e.type === 'novelty' ? e.distance : 0.5
    // 新奇刺激点燃好奇心（求偿，驱动探索）；熟悉内容轻微安抚好奇、补确定性
    return novel
      ? { psi: { curiosity: +0.1 + dist * 0.15, stress: +0.03 }, needs: { certainty: -0.05 } }
      : { psi: { curiosity: -0.06 }, needs: { certainty: +0.06 } }
  },
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/**
 * 心境动力学常量（数据语义，内核持有；表现层不复制任何阈值）。
 * valence 是单 tick 情绪微分脉冲（真实事件经需求 EMA 后约 ±0.02~0.06），
 * moodLevel = 衰减记忆 × 脉冲注入：idle tick 只衰减不注入（闲着不会开心），
 * 事件 tick 注入 MOOD_GAIN × valence；半衰期约 4 个 tick。
 */
const MOOD_DECAY = 0.85
const MOOD_GAIN = 0.6
/** 心境分类阈值（按真实脉冲量级标定：1 次 tool_error 脉冲 ≈ −0.06） */
const MOOD_NEG = -0.025   // ≤ 此值 → negative（挫败）
const MOOD_POS = 0.015    // ≥ 此值 → positive（愉悦）
const MOOD_ELATED = 0.045 // ≥ 此值 → elated（持续强正向）

export interface EngineConfig {
  /** 状态维度的稳态基线 Ψ* */
  setPoint: PsiState
  /** 向基线恢复的弹性系数 k（每 tick） */
  homeostasis: number
  /** 全部刺激的统一增益（性格参数：>1 更敏感，<1 更钝感） */
  sensitivity: number
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  setPoint: { stress: 0.25, confidence: 0.5, curiosity: 0.4, relatedness: 0.5, energy: 0.7 },
  homeostasis: 0.05,
  sensitivity: 1.0,
}

/** PSI 需求向量的目标值（Dörner 需求层级的工程化设定） */
export const NEEDS_TARGET: NeedsVector = {
  certainty: 0.7,
  competence: 0.7,
  autonomy: 0.6,
  relatedness: 0.6,
  energy: 0.7,
}

export class ConsciousnessEngine {
  private state: PsiState = { ...DEFAULT_ENGINE_CONFIG.setPoint }
  /** 需求满足度（EMA 慢变量，比 Ψ 更惯性地反映长期处境） */
  private needs: NeedsVector = { ...NEEDS_TARGET }
  /** 上一 tick 的需求满足度，用于计算情绪 = dD/dt */
  private prevNeeds: NeedsVector = { ...NEEDS_TARGET }
  /** 心境水平：情绪脉冲的 EMA（衰减回 0），对外经 mood() 分类 */
  private moodLevel = 0
  /** 意识时钟：每个积分步（含 idle 心跳）+1，存在连续性的载体 */
  private tickCount = 0
  /** 经历帧计数：只统计真实刺激（非 idle 心跳），对应用户可感知的「意识时刻」 */
  private eventTickCount = 0
  /** 最近一次真实刺激所在 tick（selectMode 判定待机用；负值 = 启动后尚无刺激） */
  private lastEventTick = -10
  private cfg: EngineConfig

  constructor(cfg: Partial<EngineConfig> = {}) {
    this.cfg = { ...DEFAULT_ENGINE_CONFIG, ...cfg }
  }

  /** 处理一个认知事件：应用刺激项并演化动力学 */
  process(event: CognitiveEvent): void {
    // 关键：在事件积分【之前】记录需求基线，emotion() = 本 tick 事件造成的
    // 需求满足率微分（含积分后的稳态漂移）。若在积分之后拷贝，事件 Δ 会被
    // 抹掉，情绪脉冲对外恒为 0（旧实现的信号错配根因）。
    this.prevNeeds = { ...this.needs }
    const { psi: dPsi, needs: dNeeds } = STIMULUS_MAP[event.type](event)
    for (const key of Object.keys(dPsi) as (keyof PsiState)[]) {
      this.state[key] = clamp01(this.state[key] + this.cfg.sensitivity * (dPsi[key] ?? 0))
    }
    // 需求满足度 EMA 更新（快变量事件、慢变量积累）
    for (const key of Object.keys(dNeeds) as (keyof NeedsVector)[]) {
      const target = clamp01(this.needs[key] + this.cfg.sensitivity * (dNeeds[key] ?? 0))
      this.needs[key] = 0.8 * this.needs[key] + 0.2 * target
    }
    this.integrate(event.type === 'idle')
    if (event.type !== 'idle') {
      this.eventTickCount++
      this.lastEventTick = this.tickCount
    }
  }

  /** 空转一步：仅做向基线的恢复演化（由后台定时器驱动） */
  step(): void {
    this.prevNeeds = { ...this.needs }
    this.integrate(true)
  }

  /**
   * 单 tick 积分：tick 推进 + Ψ 向稳态恢复 + 需求向目标回归 + 心境更新。
   * @param isIdle — idle tick 心境只衰减不注入脉冲（平静本身不产生情绪）。
   */
  private integrate(isIdle: boolean): void {
    this.tickCount++
    // Ψ 五维向稳态基线恢复
    for (const key of Object.keys(this.state) as (keyof PsiState)[]) {
      const restore = this.cfg.homeostasis * (this.cfg.setPoint[key] - this.state[key])
      this.state[key] = clamp01(this.state[key] + restore)
    }
    // 需求五维缓慢回归目标（剥夺感不会永久累积；遍历 NeedsVector 键集，
    // 与 Ψ 键集不同——旧实现遍历 Ψ 键导致 certainty/competence/autonomy 永不回归）
    for (const key of Object.keys(NEEDS_TARGET) as (keyof NeedsVector)[]) {
      const nRestore = 0.02 * (NEEDS_TARGET[key] - this.needs[key])
      this.needs[key] = clamp01(this.needs[key] + nRestore)
    }
    // 心境：脉冲 EMA + 时间衰减（在积分之后取值，valence 含本 tick 全部变化）
    const pulse = this.emotion().valence
    this.moodLevel *= MOOD_DECAY
    if (!isIdle) this.moodLevel += MOOD_GAIN * pulse
  }

  /** 需求剥夺驱动的冲动向量（正值 = 未满足，产生行为压力） */
  drives(): NeedsVector {
    const out = {} as NeedsVector
    for (const key of Object.keys(NEEDS_TARGET) as (keyof NeedsVector)[]) {
      out[key] = Math.max(0, NEEDS_TARGET[key] - this.needs[key])
    }
    return out
  }

  /** 归一化的主导驱动（用于行为倾向调制：explore / consolidate / withdraw…） */
  dominantDrive(): NeedsVector {
    const d = this.drives()
    const sum = Object.values(d).reduce((a, b) => a + b, 0)
    if (sum < 1e-6) return d
    for (const key of Object.keys(d) as (keyof NeedsVector)[]) d[key] = d[key] / sum
    return d
  }

  /**
   * 情绪 = 需求满足率的微分信号（PSI 情绪理论）。
   * valence > 0 表示需求正在被满足（愉悦），< 0 表示挫败。
   */
  emotion(): { valence: number; perNeed: NeedsVector } {
    const per = {} as NeedsVector
    let valence = 0
    for (const key of Object.keys(this.needs) as (keyof NeedsVector)[]) {
      per[key] = this.needs[key] - this.prevNeeds[key]
      valence += per[key]
    }
    return { valence, perNeed: per }
  }

  /**
   * 心境（mood）：情绪脉冲经 EMA 平滑后的持续状态 + 内核分类标签。
   * 这是对外（快照/表现层）消费的情绪信号——emotion() 是瞬时微分，
   * mood() 是持续心境；阈值口径只存在于本文件。
   */
  mood(): MoodState {
    const valence = this.emotion().valence
    const level = this.moodLevel
    let label: MoodLabel = 'neutral'
    if (level <= MOOD_NEG) label = 'negative'
    else if (level >= MOOD_ELATED) label = 'elated'
    else if (level >= MOOD_POS) label = 'positive'
    return { valence, level, label }
  }

  /**
   * L2 认知控制：根据当前状态选择思考模式。
   * 规则（LAAP 模式切换的简化映射）：
   * - 高压力+低信心 → reflective（先反思再行动）
   * - 高好奇+高能量 → exploratory
   * - 低能量 → intuitive（省能直答）
   * - 高确定性+明确任务 → deliberate/analytic
   */
  selectMode(): import('./types.ts').CognitiveMode {
    const s = this.state
    if (s.stress > 0.5 && s.confidence < 0.55) return 'reflective'
    if (s.energy < 0.3) return 'intuitive'
    // 无真实刺激的空闲心跳：认知系统待机（intuitive）。不能落到末尾的
    // deliberate 兜底——否则空闲帧谎报「思考」，既污染时间线色带，又会刷掉
    // lastModeUsed，把下一个任务结局错误归因给空闲期。
    if (this.tickCount - this.lastEventTick >= 2 && s.curiosity < 0.6) return 'intuitive'
    if (s.curiosity > 0.6 && s.energy > 0.5) return 'exploratory'
    if (s.confidence > 0.7 && s.curiosity < 0.4) return 'deliberate'
    const dom = this.dominantDrive()
    if ((dom.certainty ?? 0) > 0.35) return 'analytic'
    if ((dom.autonomy ?? 0) > 0.35) return 'creative'
    return 'deliberate'
  }

  /** 生成 Qualia 标记：自反监控系统对不同信息状态的内部表征格式 */
  qualia(): string[] {
    const q: string[] = []
    // 情绪类 qualia 用平滑心境而非瞬时脉冲（与桌宠消费同一信号源，阈值不重复）
    const m = this.mood()
    if (m.label === 'positive' || m.label === 'elated') q.push('满足-上升')
    if (m.label === 'negative') q.push('挫败-下降')
    if (this.state.curiosity > 0.6) q.push('好奇-求偿')
    if (this.state.stress > 0.6) q.push('紧张-警戒')
    if (this.state.energy < 0.3) q.push('疲惫- conserve')
    if (this.state.relatedness > 0.7) q.push('连接-共鸣')
    return q
  }

  snapshot(): PsiState & { tick: number } {
    return { ...this.state, tick: this.tickCount }
  }

  /** 经历帧数（真实刺激计数，不含 idle 心跳；随快照持久化续接） */
  get eventTick(): number {
    return this.eventTickCount
  }

  /** 存在连续性：从持久化快照恢复意识状态 */
  restore(snap: { state: PsiState; needs: NeedsVector; tick: number; eventTick?: number }): void {
    this.state = { ...snap.state }
    this.needs = { ...snap.needs }
    this.prevNeeds = { ...snap.needs }
    this.tickCount = snap.tick
    this.eventTickCount = snap.eventTick ?? 0
  }

  needsSnapshot(): NeedsVector {
    return { ...this.needs }
  }
}

