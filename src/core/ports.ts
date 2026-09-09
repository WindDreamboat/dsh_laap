/**
 * 内核端口（Ports）—— 依赖反转原则（DIP）的抽象层
 *
 * LaapKernel 不直接依赖任何具体宿主（cordis logger、全局定时器、zvec、嵌入 API），
 * 它只依赖这里定义的接口；具体实现由外层适配器注入：
 *  - dsh 宿主：src/adapters/cordis/ 用 cordis ctx.logger / ctx.effect 实现 KernelLogger / 生命周期；
 *  - 记忆：src/core/memory/store.ts 的 zvec MemoryLayer 实现 MemoryPort；
 *  - 嵌入：src/core/memory/embed.ts 的 hashEmbed / openaiEmbed 即 EmbedAsyncFn 实现。
 *
 * 本文件零运行时依赖（类型仅 import type），可在任意 JS 运行时被内核引用。
 */
import type { MemoryDoc, MemoryKind, RecallResult } from './memory/store.ts'

/** 日志端口：内核只需要 info/warn 两级（cordis console/任意宿主均可适配） */
export interface KernelLogger {
  info(msg: string): void
  warn(msg: string): void
}

/**
 * 调度端口：周期性后台任务（心跳）。
 * 返回值是清理函数（停止该定时器），由内核在 dispose 时调用，
 * 从而不直接持有全局 setInterval 句柄、也不认识 cordis 的 ctx.effect。
 */
export interface KernelScheduler {
  setInterval(cb: () => void, ms: number): () => void
}

/**
 * 记忆端口：内核消费的长期/工作记忆能力。
 * zvec 实现见 memory/store.ts 的 MemoryLayer（implements MemoryPort）；
 * 测试或别的向量后端可提供自己的实现。
 */
export interface MemoryPort {
  remember(doc: MemoryDoc): Promise<{ id: string; deduplicated?: string }>
  recall(query: string, opts?: { topk?: number; kind?: MemoryKind }): Promise<RecallResult[]>
  listSkills(limit?: number): MemoryDoc[]
  /** 删除一条长期记忆（技能合并更新用） */
  forget(id: string): void
  pushWorking(item: string, archiveTo?: { id: string; ts: number }): void
  getWorking(): string[]
  close(): void
}

/**
 * 平台适配器：宿主把三类平台能力打包成一个对象注入内核（全部可选，缺省走内置默认）。
 *
 * 端口归属约定（六边形边界；新增宿主能力前先对照这里）：
 *  - Logger / Scheduler / Memory：内核运行必需的平台服务，由适配器实现并注入；
 *  - EventBus：**不设端口**。内核内部已有 CognitiveBus（意识总线）；宿主事件
 *    （会话/工具回调）在适配层转换后经 LaapKernel.perceive() 进入感知流水线；
 *  - ToolRegistry：**不设端口**。laap_* 工具是宿主侧的能力投影（dsh 用
 *    defineTool + ctx.tools.register），工具协议因平台而异，不进入内核契约；
 *  - 嵌入：EmbedAsyncFn 是纯函数注入（LaapKernelOptions.embed），不是有状态端口。
 *
 * 平台缺省值：Node/任意 JS 运行时「什么都不传」即得到 consoleLogger +
 * defaultScheduler + zvec MemoryLayer（组装见 kernel.ts 的 createKernel）；
 * dsh 适配器实现见 src/adapters/cordis/。
 */
export interface PlatformAdapter {
  logger?: KernelLogger
  scheduler?: KernelScheduler
  memory?: MemoryPort
}

/** 默认日志：console，带 [laap] 前缀（脱离 dsh 单独运行内核时使用） */
export const consoleLogger: KernelLogger = {
  info: (msg) => console.log(`[laap] ${msg}`),
  warn: (msg) => console.warn(`[laap] ${msg}`),
}

/** 静默日志：测试用，不产生任何输出 */
export const silentLogger: KernelLogger = {
  info: () => {},
  warn: () => {},
}

/** 默认调度：全局 setInterval / clearInterval（Node 与浏览器均有） */
export const defaultScheduler: KernelScheduler = {
  setInterval(cb, ms) {
    const handle = setInterval(cb, ms)
    return () => clearInterval(handle)
  },
}
