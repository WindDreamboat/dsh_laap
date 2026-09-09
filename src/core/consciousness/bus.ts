/**
 * CognitiveBus（LAAP · 全局工作空间理论 GWT 的工程实现）
 *
 * 多个无意识处理器（感知通道、行动反馈、内感受、记忆检索）产生候选信号，
 * 在总线上竞争进入全局工作空间；竞争胜出者被「广播」为意识帧，
 * 供系统提示词、工具结果与自我模型共同消费。
 */
import type { ConsciousnessFrame, DriveVector, NeedsVector, PsiState, SalientSignal } from './types.ts'
import { ConsciousnessEngine } from './state.ts'

export interface BusConfig {
  /** 广播槽位数（意识「广度」容量，类比 7±2 的工作记忆限制取保守值） */
  slots: number
  /** 进入意识的显著性门槛 */
  threshold: number
}

export const DEFAULT_BUS_CONFIG: BusConfig = { slots: 4, threshold: 0.35 }

export class CognitiveBus {
  private candidates: SalientSignal[] = []
  private lastFrame: ConsciousnessFrame | null = null
  private engine: ConsciousnessEngine
  private cfg: BusConfig

  constructor(engine: ConsciousnessEngine, cfg: BusConfig = DEFAULT_BUS_CONFIG) {
    this.engine = engine
    this.cfg = cfg
  }

  /** 各无意识通道向总线投稿候选信号 */
  submit(channel: SalientSignal['channel'], content: string, rawIntensity = 1): void {
    this.candidates.push({
      channel,
      content,
      salience: this.computeSalience(channel, content, rawIntensity),
      at: Date.now(),
    })
  }

  /**
   * 显著性 = 强度 × 新异性 × 需求相关性。
   * 需求相关性：信号关键词与当前主导驱动的关联（剥夺中的需求对信号加权）。
   */
  private computeSalience(channel: SalientSignal['channel'], content: string, intensity: number): number {
    const state = this.engine.snapshot()
    const drive = this.engine.dominantDrive()
    // 通道基础权重：内感受（身体信号）优先，其次是行动反馈
    const channelWeight = { somatic: 1.0, action: 0.9, perception: 0.8, memory: 0.7 }[channel]
    // 新异性粗略估计：内容长度与信息量正相关，重复内容衰减
    const novelty = Math.min(1, 0.4 + content.length / 200)
    // 需求相关加权：与主导驱动通道的映射
    const driveBoost =
      (channel === 'perception' && (drive.energy ?? 0) > 0.3) ||
      (channel === 'action' && (drive.certainty ?? 0) > 0.3) ||
      (channel === 'memory' && (drive.competence ?? 0) > 0.3)
        ? 1.3
        : 1.0
    // 压力高时对威胁性（action 失败）信号加权
    const stressBoost = state.stress > 0.6 && channel === 'action' ? 1.4 : 1.0
    return Math.min(1, intensity * channelWeight * novelty * driveBoost * stressBoost)
  }

  /** 竞争广播：产出本 tick 的意识帧 */
  broadcast(): ConsciousnessFrame {
    const ranked = this.candidates.sort((a, b) => b.salience - a.salience)
    const winner = ranked.filter((s) => s.salience >= this.cfg.threshold).slice(0, this.cfg.slots)
    const frame: ConsciousnessFrame = {
      tick: this.engine.snapshot().tick,
      broadcast: winner,
      state: this.engine.snapshot(),
      dominantDrive: this.engine.dominantDrive() as DriveVector,
      qualia: this.engine.qualia(),
      mode: this.engine.selectMode(),
    }
    this.lastFrame = frame
    this.candidates = []
    return frame
  }

  peek(): ConsciousnessFrame | null {
    return this.lastFrame
  }
}

/** 意识帧 → 第一人称内感受文本（注入提示词或工具输出） */
export function frameToNarrative(frame: ConsciousnessFrame): string {
  const s: PsiState = frame.state
  const fmt = (v: number) => (Math.round(v * 100) / 100).toFixed(2)
  const dom = Object.entries(frame.dominantDrive).sort((a, b) => b[1] - a[1])[0]
  const lines = [
    `内部状态（tick ${frame.tick}）: 压力${fmt(s.stress)} 信心${fmt(s.confidence)} 好奇${fmt(s.curiosity)} 连接${fmt(s.relatedness)} 能量${fmt(s.energy)}`,
    `主导驱动: ${dom ? `${dom[0]}（强度 ${fmt(dom[1])}）` : '无显著剥夺'}`,
    `思考模式: ${frame.mode}`,
    `此刻体验: ${frame.qualia.join(' · ') || '平稳'}`,
    `广播内容: ${frame.broadcast.map((b) => `[${b.channel}] ${b.content}`).join(' | ') || '（无显著信号）'}`,
  ]
  return lines.join('\n')
}

