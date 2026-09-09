/**
 * UI 快照数据契约（server / browser 双端共享的唯一类型源）。
 *
 * 本文件**零运行时依赖**（仅 type-only import），因此：
 *  - 服务端：LaapKernel.uiSnapshot() 以此为返回类型；
 *  - 浏览器端：ui-client / pet-fsm 以 `import type` 引用，esbuild 打包时
 *    类型导入被整体擦除，不会把任何内核代码带进 client bundle。
 *
 * 架构约定：内核只负责生成数据（情绪脉冲、心境分类、认知模式、空闲时长…），
 * 表现层只负责消费数据（映射成立绘/动画），双方不再各自重算同一语义。
 */
import type { CognitiveMode, MoodState, NeedsVector, PsiState } from './consciousness/types.ts'

/** 意识帧日志条目的快照投影（时间线原料） */
export interface UiSnapshotFrame {
  tick: number
  mode: CognitiveMode
  qualia: string[]
  salience: number
  at: number
}

/** 元认知监控摘要的快照投影 */
export interface UiSnapshotMonitor {
  traces: number
  calibrated: number
  failureRate: number
}

/** uiSnapshot() 的完整 JSON 形状（纯数据，可结构化克隆 / 经 RPC 与 SSE 传输） */
export interface UiSnapshot {
  /** 五维意识状态向量 + tick */
  state: PsiState & { tick: number }
  /** 五维需求满足度 */
  needs: NeedsVector
  /** 归一化主导驱动 */
  drives: NeedsVector
  /** 原始情绪微分（单 tick 脉冲） */
  emotion: { valence: number; perNeed: NeedsVector }
  /** 心境（EMA 平滑水平 + 内核分类标签，表现层直接映射） */
  mood: MoodState
  /** 距上次非 idle 认知事件的秒数（空闲判定的数据原料） */
  idleSeconds: number
  monitor: UiSnapshotMonitor
  modeStats: Record<string, { winRate: number; trials: number }>
  /** 工作记忆（当前意识流要点） */
  working: string[]
  /** 已沉淀技能数 */
  skills: number
  /** 意识续接来源（冷生意识为 null） */
  restoredFrom: { savedAt: number; tick: number } | null
  frameLog: UiSnapshotFrame[]
}
