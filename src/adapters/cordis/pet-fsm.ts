/**
 * 桌宠有限状态机（纯表现层逻辑，零 React / DOM 依赖，可独立单测）。
 *
 * 架构：状态同步，不做状态重算。
 *  - 内核负责生成【数据】：心境分类 mood.label、认知模式 mode、空闲秒数
 *    idleSeconds；阈值口径全部在内核（src/core/consciousness/state.ts）。
 *  - 本文件只做【映射】：把内核信号经一张优先级裁决表投影成 PetState，
 *    不持有任何情绪/能量阈值、不硬编码模式字符串语义（类型来自内核共享
 *    类型源，模式新增/改名在编译期即可发现）。
 *  - 本地仅保留两类表现层职责：时间滞回（候选态持续 HYSTERESIS_MS 才
 *    落地，防阈值附近抖图）与点击活跃（poke 后短时间不显示休息）。
 */
import type { CognitiveMode, MoodLabel } from '../../core/consciousness/types.ts'

export type PetState = 'idle' | 'happy' | 'like' | 'angry' | 'study' | 'explore' | 'rest'

export const PET_STATE_LABEL: Record<PetState, string> = {
  idle: '待机', happy: '开心', like: '喜欢', angry: '生气', study: '专注', explore: '好奇', rest: '休息',
}

/** 候选态持续多久才落地（ms）：表现层防抖参数，与信号语义无关 */
const HYSTERESIS_MS = 3000
/** 点击桌宠后多久内不进入休息（ms）：纯本地交互反馈 */
const POKE_AWAKE_MS = 90_000
/** 内核空闲多久表现为休息（ms）：表现节奏参数；空闲事实本身由内核 idleSeconds 给出 */
export const PET_IDLE_MS = 90_000

/** 专注类模式 → study（集引用内核 CognitiveMode，编译期共享枚举） */
const FOCUS_MODES: ReadonlySet<CognitiveMode> = new Set<CognitiveMode>(['deliberate', 'analytic'])

export interface FsmInput {
  /** 内核分类好的心境（不再是原始数值） */
  mood: MoodLabel
  /** 内核当前认知模式（帧定稿后的实际生效模式） */
  mode: CognitiveMode
  /** 内核判定的空闲（idleSeconds 超表现节奏阈值） */
  idle: boolean
  now: number
}

export class PetFsm {
  state: PetState = 'idle'
  private cand: PetState | null = null
  private candSince = 0
  private lastPokeAt: number

  constructor(now: number = Date.now()) {
    this.lastPokeAt = now
  }

  /**
   * 映射表（纯函数）：内核信号 → 表现状态。
   * 优先级：生气 > 空闲休息 > 专注 > 好奇 > 低能量休息 > 喜欢 > 开心 > 待机。
   * rest 信号来自内核：idle（长时间无认知事件 → 入睡，优先于过期的模式帧）
   * 或 intuitive 模式（内核低能量省能档位）——表现层不再自设能量阈值。
   */
  static desired(i: FsmInput): PetState {
    if (i.mood === 'negative') return 'angry'
    if (i.idle) return 'rest'
    if (FOCUS_MODES.has(i.mode)) return 'study'
    if (i.mode === 'exploratory') return 'explore'
    if (i.mode === 'intuitive') return 'rest'
    if (i.mood === 'elated') return 'like'
    if (i.mood === 'positive') return 'happy'
    return 'idle'
  }

  update(i: FsmInput): PetState {
    // 点击唤醒：本地交互后的宽限期内不显示休息
    const idle = i.idle && i.now - this.lastPokeAt > POKE_AWAKE_MS
    const d = PetFsm.desired({ ...i, idle })
    if (d === this.state) {
      this.cand = null
    } else if (this.cand !== d) {
      this.cand = d
      this.candSince = i.now
    } else if (i.now - this.candSince >= HYSTERESIS_MS) {
      this.state = d
      this.cand = null
    }
    return this.state
  }

  /** 用户交互（点击）：刷新活跃时间，避免一点就睡 */
  poke(now: number): void {
    this.lastPokeAt = now
  }
}
