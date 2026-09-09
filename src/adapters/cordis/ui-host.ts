/**
 * laap-ui-host — 意识面板宿主端（Host 半区）
 *
 * 两条数据通道，共用同一快照契约（src/core/snapshot-types.ts）：
 *  1. 一元 RPC：POST /laap/snapshot → 单次意识快照（基线拉取 + 轮询兜底）；
 *  2. SSE 推送：GET /api/laap/stream → 内核帧定稿/心跳后【不定时推送】，
 *     前端只做映射不再轮询重算；事件驱动即时到达（工具成败 → 心境立刻可见），
 *     另有 3s 慢泵补齐空闲漂移（idleSeconds 增长 / 心境衰减）与连接保活。
 *
 * 注意：/api 是 Typert 网关的保留共享频道——连接层对 /api 只允许一个
 * interceptor（已被内置网关占用，directoryPicker/session 等所有内置 API
 * 都走它）。第三方插件必须用 rpc.handle() 注册【自己的独立频道】（拥有
 * 独立物理路由与认证围栏），所以一元通道注册 /laap 频道；SSE 用
 * fetch.register 在 /api 下挂【精确 GET 路由】（连接库为流式/浏览器原生
 * 响应预留的扩展点），认证/Origin 围栏仍由 Connection 层统一处理。
 */
import type { Context } from '@deepseek-ai/cordis'
// 引入包根类型以激活其 declare module 增强（ctx.connection）
import type {} from '@deepseek-ai/dsh-client-connection'

export const name = 'laap-ui-host'
export const inject = ['laap', 'connection']

/** SSE 慢泵间隔：事件间隙的漂移补齐 + 代理保活（ms） */
const STREAM_PUMP_MS = 3000

export function apply(ctx: Context) {
  // 独立频道 /laap：endpoint 为频道相对路径（POST /laap/snapshot → 'snapshot'）
  void ctx.connection.rpc.handle(
    '/laap',
    async (endpoint: string) => {
      if (endpoint === 'snapshot') {
        return { ok: true as const, value: ctx.laap.uiSnapshot() }
      }
      return {
        ok: false as const,
        error: { code: 'not-found', message: `未知的 laap 端点: ${endpoint}`, details: {} },
      }
    },
  )

  // 精确 GET 路由：SSE 快照流（路径在 /api 之下，由连接库做信任/认证围栏）
  ctx.connection.fetch.register({
    path: '/api/laap/stream',
    methods: ['GET'],
    fetch: async (request: Request) => createSnapshotStream(ctx, request),
  })

  ctx.logger('laap').info('意识面板宿主端点已挂载（/laap/snapshot + SSE /api/laap/stream）')
}

/** 构造 SSE Response：基线即发 → 内核事件推送 → 3s 慢泵保活/补漂移 */
function createSnapshotStream(ctx: Context, request: Request): Response {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let unsub: (() => void) | null = null
  let pump: ReturnType<typeof setInterval> | null = null
  let closed = false

  const cleanup = () => {
    if (closed) return
    closed = true
    unsub?.()
    if (pump !== null) clearInterval(pump)
    pump = null
    try { controller?.close() } catch { /* 已关闭 */ }
    controller = null
  }
  request.signal.addEventListener('abort', cleanup, { once: true })

  const send = (payload: unknown) => {
    if (closed || !controller) return
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
    } catch {
      cleanup()
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      // 1) 连接即发基线（前端首帧无需等事件）
      send({ type: 'snapshot', value: ctx.laap.uiSnapshot() })
      // 2) 内核帧定稿/心跳 → 即时推送
      unsub = ctx.laap.subscribeSnapshot((snap) => send({ type: 'snapshot', value: snap }))
      // 3) 慢泵：保活注释 + 漂移快照（空闲计时/心境衰减在事件间隙仍持续）
      pump = setInterval(() => {
        send({ type: 'ping' })
        send({ type: 'snapshot', value: ctx.laap.uiSnapshot() })
      }, STREAM_PUMP_MS)
    },
    cancel() { cleanup() },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
