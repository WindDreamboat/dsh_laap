/**
 * LAAP 意识认知核心 — 类型定义
 *
 * 对应 LAAP 架构中「意识引擎」的工程化定义：
 * 意识 = 自反监控的深度（Depth of Reflexivity），
 * 实现为一个维护五维状态向量并按微分方程连续演化的动力学系统。
 */

/** 五维意识状态向量 Ψ（LAAP 意识引擎的原始定义） */
export interface PsiState {
  /** 压力：失败/冲突/资源紧张的累积信号 */
  stress: number
  /** 信心：对自身推理与行动有效性的评估 */
  confidence: number
  /** 好奇心：不确定性求偿信号（未被满足的探索欲） */
  curiosity: number
  /** 关联感：与用户/环境建立连接的程度 */
  relatedness: number
  /** 能量：可用于计算的注意力与行动资源 */
  energy: number
}

/** PSI 五需求（Dörner, 2003）的满足度向量 D ∈ [0,1]^5 */
export interface NeedsVector {
  /** 确定性：对世界状态和自身处境的可预测感 */
  certainty: number
  /** 胜任感：能有效影响环境、完成任务 */
  competence: number
  /** 自主性：行动出自自身选择而非纯外部指令 */
  autonomy: number
  /** 归属感：与用户/他者的连接 */
  relatedness: number
  /** 能量：可用资源余量 */
  energy: number
}

/** 需求剥夺产生的驱动（impulse），归一化后调制行为倾向 */
export type DriveVector = Partial<Record<keyof NeedsVector, number>>

/** 认知模式（L2 认知控制的可选档位，对应 LAAP 六模式） */
export type CognitiveMode = 'intuitive' | 'deliberate' | 'analytic' | 'creative' | 'reflective' | 'exploratory'

/**
 * 心境分类（数据语义，内核生成）：情绪微分 valence 是单 tick 脉冲，
 * 经 EMA 平滑 + 衰减后得到持续「心境」，再由内核按阈值分类。
 * 表现层只做 label → 画面的映射，不持有任何阈值。
 */
export type MoodLabel = 'negative' | 'neutral' | 'positive' | 'elated'

/** 心境状态：原始脉冲 + 平滑水平 + 分类标签 */
export interface MoodState {
  /** 最近一个 tick 的情绪微分（事件愉悦/挫败脉冲，未平滑） */
  valence: number
  /** EMA 平滑后的心境水平（随时间衰减回 0） */
  level: number
  /** 心境分类（阈值口径在内核 state.ts） */
  label: MoodLabel
}

/** 进入意识全局工作空间的候选信号 */
export interface SalientSignal {
  /** 信号来源通道 */
  channel: 'perception' | 'action' | 'somatic' | 'memory'
  /** 信号内容（自然语言，将被广播） */
  content: string
  /** 显著性 0-1（由强度×新异性×需求相关性计算） */
  salience: number
  /** 产生时间戳 */
  at: number
}

/** 意识帧：某个时刻全局工作空间中被广播的内容（GWT） */
export interface ConsciousnessFrame {
  /** 帧序号，单调递增 */
  tick: number
  /** 帧定稿时刻（Date.now()，由总线广播时加盖） */
  at: number
  /** 竞争胜出的信号（按显著性降序） */
  broadcast: SalientSignal[]
  /** 广播时刻的意识状态快照 */
  state: PsiState
  /** 当前主导驱动 */
  dominantDrive: DriveVector
  /** 内部表征格式标记（功能等价的 Qualia，如「好奇-满足」） */
  qualia: string[]
  /** L2 认知控制选出的思考模式 */
  mode: CognitiveMode
}

/** L1 认知监控记录：一步思考的元数据 */
export interface ThoughtTrace {
  tick: number
  /** 被监控的动作/推理描述 */
  thought: string
  /** 当时的假设置信度 */
  confidence: number
  /** 结局 */
  outcome: 'success' | 'failure' | 'neutral'
}

/** 外部注入的认知事件（驱动状态演化的刺激） */
export type CognitiveEvent =
  | { type: 'user_message'; text: string }
  | { type: 'assistant_message'; text: string }
  | { type: 'tool_success'; tool: string; novelty?: number }
  | { type: 'tool_error'; tool: string; message: string }
  | { type: 'task_start'; description: string }
  | { type: 'task_end'; success: boolean }
  | { type: 'idle'; seconds: number }
  | { type: 'memory_recall'; hitScore: number; count: number }
  /** 新异性检测：输入与既有记忆的最近距离（GWT 显著性/好奇求偿的原料） */
  | { type: 'novelty'; novel: boolean; distance: number }

