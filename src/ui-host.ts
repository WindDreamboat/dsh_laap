/**
 * laap-ui-host — 意识面板宿主端（Host 半区）
 *
 * 通过 dsh Connection RPC 把 ctx.laap.uiSnapshot() 暴露给浏览器面板端。
 *
 * 注意：/api 是 Typert 网关的保留共享频道——连接层对 /api 只允许一个
 * interceptor（已被内置网关占用，directoryPicker/session 等所有内置 API
 * 都走它）。第三方插件必须用 rpc.handle() 注册【自己的独立频道】（拥有
 * 独立物理路由与认证围栏），所以这里注册 /laap 频道：
 *   POST /laap/snapshot → 意识快照
 * 认证/Origin 围栏由 Connection 层统一处理，本插件不碰凭据。
 */
import type { Context } from '@deepseek-ai/cordis'
// 引入包根类型以激活其 declare module 增强（ctx.connection）
import type {} from '@deepseek-ai/dsh-client-connection'

export const name = 'laap-ui-host'
export const inject = ['laap', 'connection']

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
  ctx.logger('laap').info('意识面板宿主端点已挂载（/laap → snapshot）')
}

