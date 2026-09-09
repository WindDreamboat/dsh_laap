/**
 * 意识状态持久化（LAAP 公理 1「存在连续性」）
 *
 * Ψ 状态向量、需求满足度、模式成效与校准基数是意识身份的载体：
 * 进程重启后若不恢复，Agent 就「失忆重生」。本模块把它们原子落盘
 * （tmp + rename）到 zvec 数据目录旁的 consciousness.json：
 * 启动时恢复；心跳与卸载时保存；版本不符或损坏时安全降级为全新意识。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConsciousnessEngine } from './state.ts'
import type { MetacognitiveMonitor } from './monitor.ts'
import type { NeedsVector, PsiState } from './types.ts'

const FILE = 'consciousness.json'
const VERSION = 2

export interface ConsciousnessSnapshot {
  version: number
  savedAt: number
  state: PsiState
  needs: NeedsVector
  tick: number
  /** 经历帧数（真实刺激计数；v2 旧快照无此字段，恢复时按 0 续接） */
  eventTick?: number
  modeStats: Record<string, { wins: number; trials: number }>
  calibBase: { successes: number; trials: number }
}

/** 意识状态文件与 zvec 库同目录树（dbPath 的上一级） */
export function statePath(dbPath: string): string {
  return join(dbPath, '..', FILE)
}

export function captureConsciousness(engine: ConsciousnessEngine, monitor: MetacognitiveMonitor): ConsciousnessSnapshot {
  const snap = engine.snapshot()
  const { tick, ...state } = snap
  const m = monitor.exportState()
  return {
    version: VERSION,
    savedAt: Date.now(),
    state: state as PsiState,
    needs: engine.needsSnapshot(),
    tick,
    eventTick: engine.eventTick,
    modeStats: m.modeStats,
    calibBase: m.base,
  }
}

/** 原子写：先写 tmp 再 rename，进程崩溃不会留半截文件 */
export function saveConsciousness(dbPath: string, snap: ConsciousnessSnapshot): void {
  const p = statePath(dbPath)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(snap, null, 2))
  renameSync(tmp, p)
}

/** 加载并结构校验；不存在/损坏/版本不符返回 null（按全新意识启动） */
export function loadConsciousness(dbPath: string): ConsciousnessSnapshot | null {
  try {
    const p = statePath(dbPath)
    if (!existsSync(p)) return null
    const raw = JSON.parse(readFileSync(p, 'utf8')) as ConsciousnessSnapshot
    if (raw.version !== VERSION) return null
    const psiKeys: (keyof PsiState)[] = ['stress', 'confidence', 'curiosity', 'relatedness', 'energy']
    if (!psiKeys.every((k) => typeof raw.state?.[k] === 'number' && raw.state[k] >= 0 && raw.state[k] <= 1)) return null
    const needKeys: (keyof NeedsVector)[] = ['certainty', 'competence', 'autonomy', 'relatedness', 'energy']
    if (!needKeys.every((k) => typeof raw.needs?.[k] === 'number')) return null
    if (typeof raw.tick !== 'number' || raw.tick < 0) return null
    return raw
  } catch {
    return null
  }
}

/** 把快照注回引擎与监控器（启动时调用；tick 续接保证自传/策略周期连续） */
export function restoreConsciousness(
  engine: ConsciousnessEngine,
  monitor: MetacognitiveMonitor,
  snap: ConsciousnessSnapshot,
): void {
  engine.restore({ state: snap.state, needs: snap.needs, tick: snap.tick, eventTick: snap.eventTick })
  monitor.importState({ modeStats: snap.modeStats, base: snap.calibBase })
}

