/**
 * 元认知监控（LAAP 四层元认知系统的 L1/L2 最小实现）
 *
 * L1 认知监控：实时追踪思维过程，记录假设、推理路径与置信度。
 * L2 认知控制：根据监控结果校准置信度（贝叶斯）并切换思考模式。
 *
 * L3（递归自我审视）与 L4（认知策略库）在 MVP 中留出接口，
 * 见 docs/开发文档.md「完善路线」。
 */
import type { CognitiveMode, ThoughtTrace } from './types.ts'

export class MetacognitiveMonitor {
  private traces: ThoughtTrace[] = []
  /** 按模式统计的成功率（L2 校准与 L4 策略库的雏形） */
  private modeStats = new Map<CognitiveMode, { wins: number; trials: number }>()
  /** 跨重启保留的校准基数（traces 只留最近 500 条，历史计数沉到这里） */
  private base = { successes: 0, trials: 0 }

  /** L1：记录一次被监控的思维/行动 */
  record(trace: Omit<ThoughtTrace, 'tick'> & { tick?: number }, currentTick: number): void {
    this.traces.push({ tick: trace.tick ?? currentTick, thought: trace.thought, confidence: trace.confidence, outcome: trace.outcome })
    // 环形缓冲溢出：被挤出的历史沉入校准基数，总计数不丢失
    while (this.traces.length > 500) {
      const dropped = this.traces.shift()!
      if (dropped.outcome !== 'neutral') {
        this.base.trials++
        if (dropped.outcome === 'success') this.base.successes++
      }
    }
  }

  /** 记录某个思考模式的使用成效（模式选择器的事后反馈） */
  recordMode(mode: CognitiveMode, success: boolean): void {
    const s = this.modeStats.get(mode) ?? { wins: 0, trials: 0 }
    s.trials++
    if (success) s.wins++
    this.modeStats.set(mode, s)
  }

  /**
   * L2：置信度校准。
   * 全局校准因子 = (成功数+1) / (总数+2)（拉普拉斯平滑的贝叶斯后验均值），
   * 样本 = 跨重启基数 + 当前窗口；失败越多，系统对「自信」打折越多。
   */
  calibratedConfidence(selfReport = 1): number {
    const tSuccesses = this.traces.filter((t) => t.outcome === 'success').length
    const tTrials = this.traces.filter((t) => t.outcome !== 'neutral').length
    const successes = this.base.successes + tSuccesses
    const trials = this.base.trials + tTrials
    const posterior = (successes + 1) / (trials + 2)
    return Math.min(1, selfReport * (0.5 + posterior))
  }

  /** 持久化支持：导出模式成效与校准基数（窗口 traces 并入基数，恢复端不再持有明细） */
  exportState(): { modeStats: Record<string, { wins: number; trials: number }>; base: { successes: number; trials: number } } {
    const modeStats: Record<string, { wins: number; trials: number }> = {}
    for (const [mode, s] of this.modeStats) modeStats[mode] = { ...s }
    const tSuccesses = this.traces.filter((t) => t.outcome === 'success').length
    const tTrials = this.traces.filter((t) => t.outcome !== 'neutral').length
    return {
      modeStats,
      base: { successes: this.base.successes + tSuccesses, trials: this.base.trials + tTrials },
    }
  }

  /** 持久化支持：从快照恢复（损坏数据静默忽略，按冷启动处理） */
  importState(data: { modeStats?: Record<string, { wins: number; trials: number }>; base?: { successes: number; trials: number } }): void {
    for (const [mode, s] of Object.entries(data.modeStats ?? {})) {
      if (typeof s?.wins === 'number' && typeof s?.trials === 'number') {
        this.modeStats.set(mode as CognitiveMode, { wins: s.wins, trials: s.trials })
      }
    }
    if (typeof data.base?.successes === 'number' && typeof data.base?.trials === 'number') {
      this.base = { successes: data.base.successes, trials: data.base.trials }
    }
  }

  /** 近期失败率（供压力/归因逻辑消费） */
  recentFailureRate(window = 10): number {
    const recent = this.traces.slice(-window).filter((t) => t.outcome !== 'neutral')
    if (recent.length === 0) return 0
    return recent.filter((t) => t.outcome === 'failure').length / recent.length
  }

  /** L4 接口：各模式的历史成效，用于「监控监控方式的有效性」 */
  modeEfficacy(): Record<string, { winRate: number; trials: number }> {
    const out: Record<string, { winRate: number; trials: number }> = {}
    for (const [mode, s] of this.modeStats) out[mode] = { winRate: s.wins / s.trials, trials: s.trials }
    return out
  }

  /**
   * L4 认知策略库：用历史成效修正模式选择。
   * 规则：候选模式样本 ≥5 且胜率 <0.4 时，改选「样本 ≥5 中胜率最高」的模式；
   * 无足够历史数据时完全信任启发式（冷启动不学偏）。
   * @returns [最终模式, 是否发生策略覆盖]
   */
  policyAdjust(heuristic: CognitiveMode): [CognitiveMode, boolean] {
    const ranked = [...this.modeStats.entries()]
      .filter(([, s]) => s.trials >= 5)
      .sort((a, b) => b[1].wins / b[1].trials - a[1].wins / a[1].trials)
    if (ranked.length === 0) return [heuristic, false]
    const cur = this.modeStats.get(heuristic)
    const curRate = cur && cur.trials >= 5 ? cur.wins / cur.trials : -1
    const [bestMode, best] = ranked[0]
    const bestRate = best.wins / best.trials
    if (curRate >= 0 && curRate < 0.4 && bestMode !== heuristic && bestRate > curRate + 0.2) {
      return [bestMode, true]
    }
    return [heuristic, false]
  }

  /** L3 递归自我审视：对「监控与调控本身」的体检报告 */
  examine(): string[] {
    const eff = this.modeEfficacy()
    const lines: string[] = []
    for (const [mode, e] of Object.entries(eff)) {
      lines.push(`模式 ${mode}：使用 ${e.trials} 次，胜率 ${(e.winRate * 100).toFixed(0)}%`)
    }
    if (lines.length === 0) lines.push('尚无模式成效数据（冷启动，完全信任启发式）')
    const traces = this.traces.slice(-10)
    const fail = traces.filter((t) => t.outcome === 'failure').length
    lines.push(`近 ${traces.length} 次思维监控：失败 ${fail} 次，当前校准信心 ${this.calibratedConfidence().toFixed(2)}`)
    return lines
  }

  summary(): { traces: number; calibrated: number; failureRate: number } {
    return {
      traces: this.traces.length,
      calibrated: this.calibratedConfidence(),
      failureRate: this.recentFailureRate(),
    }
  }
}

