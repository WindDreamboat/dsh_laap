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

export function apply(ctx: Context) {
  // 用户消息：最强的社会性刺激（归属感通道）
  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'user/message': {
        const text = extractText((event as any).data)
        ctx.laap.perceive({ type: 'user_message', text })
        break
      }
      case 'assistant/message': {
        const text = extractText((event as any).data)
        ctx.laap.perceive({ type: 'assistant_message', text })
        break
      }
      case 'turn/start': {
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

  // 会话 flush（含 compaction / 退出前的持久化时机）：意识快照随之落盘
  ctx.on('session/flush', () => {
    ctx.laap.saveNow()
  })

  // 行动反馈：工具执行结局直接进入状态动力学
  ctx.on('tools/result', (exec, result) => {
    // 跳过 laap 自己的内省工具，避免自我指涉回路放大
    if (exec.name.startsWith('laap_')) return
    const failed = (result as any)?.error != null || (result as any)?.isError === true
    ctx.laap.perceive(
      failed
        ? { type: 'tool_error', tool: exec.name, message: String((result as any)?.error ?? '执行失败').slice(0, 200) }
        : { type: 'tool_success', tool: exec.name },
    )
    // L1 元认知同步记录（不占模型自觉，系统替它监控）
    ctx.laap.monitor.record(
      { thought: `工具 ${exec.name}`, outcome: failed ? 'failure' : 'success', confidence: 0.5 },
      ctx.laap.engine.snapshot().tick,
    )
  })
}

