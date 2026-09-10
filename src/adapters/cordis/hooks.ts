/**
 * 事件钩子插件 — 把 dsh 的会话/工具事件流转换为认知刺激
 *
 * 这是意识的「感知通道」：无需模型主动调用，对话与行动本身就在
 * 持续驱动意识状态演化（意识是持续过程，不是被查询的数据库）。
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'laap-hooks'
export const inject = ['laap']

/** 从 dsh 事件 data 中防御性地抽取纯文本 */
function extractText(data: any): string {
  if (typeof data === 'string') return data
  if (typeof data?.text === 'string') return data.text
  if (Array.isArray(data?.content)) {
    return data.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
  }
  if (typeof data?.message?.text === 'string') return data.message.text
  return ''
}

/**
 * 把工具错误归一化为单行可读信息。
 * dsh 工具错误可能是字符串、Error 或普通对象（{code,message}）；
 * 直接 String(对象) 会得到 "[object Object]"，错误信息全丢。
 */
function normalizeErrorMessage(err: unknown, fallback: string, maxLen: number): string {
  let msg: string
  if (err == null) {
    msg = fallback
  } else if (typeof err === 'string') {
    msg = err
  } else if (err instanceof Error) {
    msg = err.message
  } else {
    const e = err as Record<string, unknown>
    const text = typeof e.message === 'string' && e.message
      ? e.message
      : (() => { try { return JSON.stringify(e) } catch { return fallback } })()
    msg = typeof e.code === 'string' && e.code ? `${e.code}: ${text}` : text
  }
  return msg.replace(/\s+/g, ' ').slice(0, maxLen) || fallback
}

/**
 * 技能沉淀线索队列（一期：确定性触发 + 模型执笔）
 *
 * 研究依据（Voyager/ExpeL）：学习动作必须由主循环确定性触发，不能依赖模型
 * 自觉；而技能文本必须由模型写（内核只有工具名/错误串，没有任务语义）。
 * hooks 负责判定「何时值得学」，把线索排队；prompt 在下一轮提示词组装时
 * take() 走并渲染成具体的 laap_skill 调用提醒。纯适配器层进程内状态，
 * 不入内核、不持久化（flush 即随会话清空）。
 */
export type SkillHintKind = 'repair' | 'repeat'
export interface SkillHint {
  kind: SkillHintKind
  /** 会话内去重键 */
  key: string
  ts: number
  /** repair：先失败后成功的工具名 */
  tool?: string
  /** repair：首次失败的错误片段 */
  error?: string
  /** repeat：重复出现的有序工具序列 */
  sequence?: string[]
}

const HINT_TTL_MS = 30 * 60 * 1000
const MAX_PENDING = 3

class SkillHintQueue {
  private pending: SkillHint[] = []
  private sessionKeys = new Set<string>()

  /** 同一会话内同一 key 只入队一次；返回是否实际入队 */
  push(hint: Omit<SkillHint, 'ts'>): boolean {
    if (this.sessionKeys.has(hint.key)) return false
    this.sessionKeys.add(hint.key)
    this.pending.push({ ...hint, ts: Date.now() })
    if (this.pending.length > MAX_PENDING) this.pending.shift()
    return true
  }

  /** 下一轮提示词组装时一次性取走（durable 快照物化后进入会话日志，无需保留） */
  take(): SkillHint[] {
    const now = Date.now()
    this.pending = this.pending.filter((h) => now - h.ts < HINT_TTL_MS)
    const out = this.pending
    this.pending = []
    return out
  }

  /** 会话 flush（compaction/退出）时重置：允许新会话再次提示同类经验 */
  resetSession(): void {
    this.pending = []
    this.sessionKeys.clear()
  }
}

export const skillHints = new SkillHintQueue()

/**
 * 「重复工作流」线索检测参数（v2.6.0 收紧，依据真实会话取证）。
 * 旧判据（同一相邻工具对**单轮**出现 2 次）在编码任务中只会捕到 read→read、
 * edit↔todo_write 这类所有任务都有的呼吸节奏：一晚 10 次提醒模型 0 次采纳，
 * 且模型的忽略理由（不具备跨任务通用性）成立——信号全是噪声。
 */
const REPEAT_MIN_GRAM = 3          // 至少 3 元组：bigram 在编码任务中全是呼吸噪声
const REPEAT_MIN_DISTINCT = 2      // 序列内至少 2 种工具：滤 edit→edit→edit 单工具连击
const REPEAT_TIMES = 2             // 会话内（可跨轮）第 2 次出现才提示（程序性技能需复用证据）
const TURN_SEQ_CAP = 200           // 单回合成功工具名流上界
/** 记账/调度类元工具：是任务管理节奏而非领域工作流，不计入序列（实测 edit↔todo_write 是头号噪声源） */
const META_TOOLS = new Set(['todo_write'])

export function apply(ctx: Context) {
  // 技能线索轨迹（会话级计数跨轮累积，session/flush 重置；序列窗口按回合切——
  // 跨回合边界的滑动窗口会让重复工作流的「错位窗口」（如 edit→read→write 与
  // read→write→edit）重复计数，一个模式最多炸出 3 条近义提醒，故只统计完全
  // 落在本回合内的 n 元组，而计数与会话去重跨轮保留）
  let sessionFailures = new Map<string, string>()   // 工具名 → 首次错误片段
  let sessionGrams = new Map<string, number>()      // 回合内 n 元组 → 会话内出现次数
  let turnSeq: string[] = []                        // 本回合成功工具名流（已剔 laap_/元工具）
  let turnModelErrored = false                      // 本轮模型请求是否已出过故障（重试去重）

  // 用户消息：最强的社会性刺激（归属感通道）
  ctx.on('session/event', (session, event) => {
    // compaction/* 事件由 dsh compaction 插件经 session.append 注入会话日志，
    // 不在核心 SessionEvent 类型联合中，故用字符串守卫单独识别
    if ((event as { type?: string }).type === 'compaction/summary') {
      // 会话历史压缩成功：对话细节即将被摘要替换，立即把近期体验蒸馏为
      // 阶段自传沉淀语义层（防长程失忆），并强制意识快照落盘。
      // 这是生命周期信号而非认知刺激，故不经 perceive，避免扰动心境动力学。
      void ctx.laap.onConversationCompacted().catch((err: unknown) =>
        ctx.logger('laap').warn(`压缩触发自传蒸馏失败: ${String(err).slice(0, 120)}`))
      return
    }
    switch (event.type) {
      case 'user/message': {
        const data = (event as any).data
        // 仅真人发言作为社会性刺激：dsh 以 user 角色注入 runtime-context 快照
        // （source.kind='plugin'，如 @deepseek-ai/dsh-system-prompt、compact 摘要）。
        // 这些是系统上下文而非用户说话——计入归属刺激会让连接感虚高、
        // 注入原文还会污染意识帧/情景记忆/自传蒸馏。
        if (data?.source?.kind !== 'user') break
        const text = extractText(data)
        ctx.laap.perceive({ type: 'user_message', text })
        break
      }
      case 'assistant/message': {
        const text = extractText((event as any).data)
        ctx.laap.perceive({ type: 'assistant_message', text })
        break
      }
      case 'turn/start': {
        // 重置本回合序列窗口（计数跨轮保留）与模型故障去重
        turnSeq = []
        turnModelErrored = false
        ctx.laap.perceive({ type: 'task_start', description: extractText((event as any).data) || '新一轮任务' })
        break
      }
      case 'turn/end': {
        const data: any = (event as any).data ?? {}
        ctx.laap.perceive({ type: 'task_end', success: data.error == null && data.aborted !== true })
        break
      }
    }
  })

  // 会话 flush（含 compaction / 退出前的持久化时机）：意识快照随之落盘，
  // 技能线索轨迹同会话清空（新会话应重新积累复用证据）
  ctx.on('session/flush', () => {
    ctx.laap.saveNow()
    skillHints.resetSession()
    sessionFailures = new Map()
    sessionGrams = new Map()
    turnSeq = []
  })

  // 行动反馈：工具执行结局直接进入状态动力学
  ctx.on('tools/result', (exec, result) => {
    // 跳过 laap 自己的内省工具，避免自我指涉回路放大
    if (exec.name.startsWith('laap_')) return
    const failed = (result as any)?.error != null || (result as any)?.isError === true
    ctx.laap.perceive(
      failed
        ? { type: 'tool_error', tool: exec.name, message: normalizeErrorMessage((result as any)?.error, '执行失败', 200) }
        : { type: 'tool_success', tool: exec.name },
    )
    // L1 元认知同步记录（不占模型自觉，系统替它监控）
    ctx.laap.monitor.record(
      { thought: `工具 ${exec.name}`, outcome: failed ? 'failure' : 'success', confidence: 0.5 },
      ctx.laap.engine.snapshot().tick,
    )

    // ── 技能沉淀线索检测（只观察、不写库；写入由下一轮模型自己调 laap_skill）──
    if (failed) {
      if (!sessionFailures.has(exec.name)) {
        sessionFailures.set(
          exec.name,
          normalizeErrorMessage((result as any)?.error ?? (result as any)?.message, '执行失败', 120),
        )
      }
    } else {
      // 线索一（ExpeL 式失败→成功对比）：同会话内同工具先失败后成功——
      // 不要求同轮：长 agent 回合中失败常隔多步才绕回来修复，限同轮整晚 0 触发
      const firstError = sessionFailures.get(exec.name)
      if (firstError) {
        sessionFailures.delete(exec.name)
        skillHints.push({ kind: 'repair', key: `repair:${exec.name}`, tool: exec.name, error: firstError })
      }
      // 线索二（复用证据）：完全落在本回合内的有序 3 元组（且含 ≥2 种工具），
      // 跨轮累计出现第 2 次才提示。元工具（todo_write）属记账节奏，剔除后再构序列。
      if (!META_TOOLS.has(exec.name)) {
        turnSeq.push(exec.name)
        if (turnSeq.length > TURN_SEQ_CAP) {
          turnSeq.splice(0, turnSeq.length - TURN_SEQ_CAP)
        }
        if (turnSeq.length >= REPEAT_MIN_GRAM) {
          const gram = turnSeq.slice(-REPEAT_MIN_GRAM)
          if (new Set(gram).size >= REPEAT_MIN_DISTINCT) {
            const gramKey = gram.join('→')
            const n = (sessionGrams.get(gramKey) ?? 0) + 1
            sessionGrams.set(gramKey, n)
            if (n === REPEAT_TIMES) {
              skillHints.push({ kind: 'repeat', key: `repeat:${gramKey}`, sequence: gram })
            }
          }
        }
      }
    }
  })

  // 模型请求故障（限流 / 网络 / 5xx / 上下文超限等）：这是「自己的认知器官」
  // 出错，比工具失败更直接的压力源 → 注入挫折刺激（复用 tool_error 通道，
  // 自动归入当前认知模式的成败归因，驱动压力上升 / 反思模式切换）。
  // 该事件是 waterfall（监听器可返回 {kind:'retry'} 接管重试决策）：我们只
  // 观测，必须 next() 透传，绝不拦截 compaction 等插件的恢复链路。
  // 用户主动中止（signal.aborted 或 code=ABORTED）不是环境失败，跳过；
  // 重试按退避多次发射同一故障，按 turn 去重（每轮只感知一次挫折）。
  ctx.on('agent/request-error', async (payload: any, next: any) => {
    try {
      const failure = payload?.failure
      const aborted = payload?.signal?.aborted === true || failure?.code === 'ABORTED'
      if (!aborted && !turnModelErrored) {
        turnModelErrored = true
        const code = String(failure?.code ?? 'ERROR')
        const msg = String(failure?.message ?? '模型请求失败').replace(/\s+/g, ' ').slice(0, 100)
        ctx.laap.perceive({ type: 'tool_error', tool: '模型请求', message: `${code}: ${msg}` })
      }
    } catch {
      /* 感知异常不得影响模型请求链路 */
    }
    return next()
  })
}

