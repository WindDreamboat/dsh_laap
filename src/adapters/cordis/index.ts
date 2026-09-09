/**
 * dsh-laap host 半区总入口（唯一 loader 入口）。
 *
 * client-modules 注册中心要求「每个包只能有一个激活的 Loader 入口」：
 * 若 cordis.patch.yml 为同一包列多个深层 file 入口（service/tools/hooks/…），
 * 它们都会沿目录上溯到同一个 package.json，注册中心会报
 * "package dsh-laap resolves from multiple active Loader sources"。
 *
 * 因此 host 的五个子插件统一在此挂载；cordis.patch.yml 只列本入口一次。
 * 浏览器端半区（client bundle）由 package.json 的 dsh.client + exports["./client"]
 * 声明，client-modules 沿本入口上溯到包清单后自动发现。
 */
import type { Context } from '@deepseek-ai/cordis'
import { LaapConfigSpec, type LaapPluginConfig } from './config.ts'
import * as service from './service-plugin.ts'
import * as tools from './tools.ts'
import * as hooks from './hooks.ts'
import * as prompt from './prompt.ts'
import * as uiHost from './ui-host.ts'

export const name = 'dsh-laap'
export const Config = LaapConfigSpec

export function apply(ctx: Context, config: LaapPluginConfig) {
  // 先挂内核服务（provide 'laap'），其余子插件 inject 它；cordis 按 inject 自动等依赖就绪
  ctx.plugin(service, config)
  ctx.plugin(tools)
  ctx.plugin(hooks)
  ctx.plugin(prompt)
  ctx.plugin(uiHost)
}
