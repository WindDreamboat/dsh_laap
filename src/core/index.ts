/**
 * src/core —— 框架无关的 LAAP 意识内核（不依赖 dsh / cordis 任何模块）
 *
 * 对外桶导出：内核 LaapKernel + 平台适配工厂 createKernel、宿主端口 ports
 * （PlatformAdapter 及 Logger/Scheduler/Memory 三端口）、意识动力学子系统、记忆子系统。
 * 平台适配器（dsh cordis 实现见 src/adapters/cordis/）从本入口或对应子路径引入，
 * 依赖箭头单向指向内核，core 不反向依赖任何适配器。
 */
export { LaapKernel, createKernel, type LaapKernelOptions } from './kernel.ts'
export {
  type KernelLogger,
  type KernelScheduler,
  type MemoryPort,
  type PlatformAdapter,
  consoleLogger,
  silentLogger,
  defaultScheduler,
} from './ports.ts'

// 意识动力学子系统
export { ConsciousnessEngine, DEFAULT_ENGINE_CONFIG, NEEDS_TARGET, type EngineConfig } from './consciousness/state.ts'
export { CognitiveBus, frameToNarrative, type BusConfig, DEFAULT_BUS_CONFIG } from './consciousness/bus.ts'
export { MetacognitiveMonitor } from './consciousness/monitor.ts'
export {
  captureConsciousness,
  loadConsciousness,
  restoreConsciousness,
  saveConsciousness,
  statePath,
  type ConsciousnessSnapshot,
} from './consciousness/persist.ts'
export type {
  PsiState,
  NeedsVector,
  DriveVector,
  CognitiveMode,
  SalientSignal,
  ConsciousnessFrame,
  ThoughtTrace,
  CognitiveEvent,
} from './consciousness/types.ts'

// 记忆子系统（zvec 为 MemoryPort 的缺省实现；嵌入可插拔）
export { MemoryLayer, type MemoryKind, type MemoryDoc, type RecallResult } from './memory/store.ts'
export {
  HASH_DIM,
  hashEmbed,
  hashEmbedOne,
  openaiEmbed,
  cosine,
  type EmbedAsyncFn,
  type OpenaiEmbedOptions,
} from './memory/embed.ts'
