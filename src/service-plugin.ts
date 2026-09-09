/**
 * laap-service — 服务类插件入口
 *
 * 在 dsh 主组合中创建 LaapService（意识内核），挂到 ctx.laap，
 * 供 laap-tools / laap-hooks / laap-prompt 及任何第三方插件 inject 使用。
 *
 * 配置来自 cordis.patch.yml 的 config 字段（Schema 校验，见 src/config.ts），
 * 环境变量仅作兜底：LAAP_ZVEC_PATH / LAAP_SENSITIVITY / LAAP_HEARTBEAT_MS。
 */
import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { LaapConfigSpec, type LaapPluginConfig } from './config.ts'
import { LaapService } from './service.ts'
import { HASH_DIM, hashEmbed, openaiEmbed, type EmbedAsyncFn } from './memory/embed.ts'

export const name = 'laap-service'
export const Config = LaapConfigSpec

export function apply(ctx: Context, raw?: Partial<LaapPluginConfig>) {
  // cordis Fiber 已按 Schema 校验并填充默认值；直接 ctx.plugin 调用缺省时逐字段兜底
  const config: LaapPluginConfig = {
    dbPath: raw?.dbPath ?? process.env.LAAP_ZVEC_PATH ?? `${homedir()}/.dsh-laap/zvec-memory`,
    sensitivity: raw?.sensitivity ?? Number(process.env.LAAP_SENSITIVITY ?? 1),
    heartbeatMs: raw?.heartbeatMs ?? Number(process.env.LAAP_HEARTBEAT_MS ?? 30000),
    consolidateEvery: raw?.consolidateEvery ?? 120,
    saveEvery: raw?.saveEvery ?? 20,
    noveltyThreshold: raw?.noveltyThreshold ?? 0.45,
    autoEpisodic: raw?.autoEpisodic ?? true,
    embedding: {
      provider: 'hash',
      baseUrl: 'https://api.openai.com/v1',
      model: 'text-embedding-3-small',
      dimension: HASH_DIM,
      apiKeyEnv: 'EMBEDDING_API_KEY',
      ...(raw?.embedding ?? {}),
    },
  }

  // ── 嵌入提供者选择 ─────────────────────────────────────────────
  let embed: EmbedAsyncFn = hashEmbed
  let dim = HASH_DIM
  if (config.embedding.provider === 'openai') {
    const apiKey = process.env[config.embedding.apiKeyEnv]
    if (!apiKey) {
      ctx.logger('laap').warn(`嵌入 provider=openai 但环境变量 ${config.embedding.apiKeyEnv} 未设置，回退哈希袋嵌入`)
    } else {
      embed = openaiEmbed({
        baseUrl: config.embedding.baseUrl,
        model: config.embedding.model,
        apiKey,
        dimension: config.embedding.dimension,
      })
      dim = config.embedding.dimension
    }
  }

  // zvec 依赖 mmap，必须本地文件系统
  if (config.dbPath.startsWith('~')) config.dbPath = homedir() + config.dbPath.slice(1)

  new LaapService(ctx, {
    dbPath: config.dbPath,
    sensitivity: config.sensitivity,
    heartbeatMs: config.heartbeatMs,
    consolidateEvery: config.consolidateEvery,
    saveEvery: config.saveEvery,
    noveltyThreshold: config.noveltyThreshold,
    autoEpisodic: config.autoEpisodic,
    embed,
    embedDim: dim,
  })
  ctx.logger('laap').info(`意识内核已启动（zvec: ${config.dbPath}｜嵌入: ${config.embedding.provider}${config.embedding.provider === 'openai' ? `/${config.embedding.model}` : ''}）`)
}

