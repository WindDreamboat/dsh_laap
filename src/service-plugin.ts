/**
 * laap-service — 服务类插件入口
 *
 * 在 dsh 主组合中创建 LaapService（意识内核），挂到 ctx.laap，
 * 供 laap-tools / laap-hooks / laap-prompt 及任何第三方插件 inject 使用。
 *
 * 配置优先级：环境变量（dsh 宿主自动加载启动目录与 ~/.dsh 下的 .env）
 *   > cordis.patch.yml 的 config 字段（Schema 校验，见 src/config.ts）> 内置默认值。
 * 支持的环境变量：LAAP_ZVEC_PATH / LAAP_SENSITIVITY / LAAP_HEARTBEAT_MS /
 *   LAAP_NOVELTY_THRESHOLD / LAAP_EMBED_PROVIDER / LAAP_EMBED_BASE_URL /
 *   LAAP_EMBED_MODEL / LAAP_EMBED_DIMENSION / LAAP_EMBED_API_KEY_ENV。
 * 仓库默认 hash 嵌入（离线 0 依赖）；本地 .env 可切换 ollama/openai 而不改仓库文件。
 */
import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { LaapConfigSpec, type LaapPluginConfig } from './config.ts'
import { LaapService } from './service.ts'
import { HASH_DIM, hashEmbed, openaiEmbed, type EmbedAsyncFn } from './core/memory/embed.ts'

export const name = 'laap-service'
export const Config = LaapConfigSpec

/** 非空环境变量字符串（dsh 宿主启动时自动加载启动目录与 ~/.dsh 下的 .env） */
function envStr(name: string): string | undefined {
  const v = process.env[name]
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined
}
/** 环境变量数值；非法数字返回 undefined */
function envNum(name: string): number | undefined {
  const v = envStr(name)
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function apply(ctx: Context, raw?: Partial<LaapPluginConfig>) {
  // 配置优先级：环境变量（本地 .env 覆写）> cordis.patch.yml > 内置默认值。
  // 开源仓库的 patch 保持 hash 默认，克隆即可离线运行；个人环境通过 .env 切换真实嵌入。
  const log = ctx.logger('laap')
  const envOverrides: string[] = []

  const envProvider = envStr('LAAP_EMBED_PROVIDER')
  if (envProvider && envProvider !== 'hash' && envProvider !== 'openai' && envProvider !== 'ollama') {
    log.warn(`LAAP_EMBED_PROVIDER=${envProvider} 非法（仅 hash/openai/ollama），已忽略`)
  }
  const envDim = envNum('LAAP_EMBED_DIMENSION')
  if (envDim !== undefined && envDim < 8) {
    log.warn(`LAAP_EMBED_DIMENSION=${envDim} 非法（需 ≥8），已忽略`)
  }

  // cordis Fiber 已按 Schema 校验并填充默认值；直接 ctx.plugin 调用缺省时逐字段兜底
  const embedding: LaapPluginConfig['embedding'] = {
    provider: 'hash',
    baseUrl: '',
    model: 'dsha256',
    dimension: HASH_DIM,
    apiKeyEnv: 'EMBEDDING_API_KEY',
    ...(raw?.embedding ?? {}),
  }
  // 环境变量最后覆盖 embedding 子字段
  if (envProvider && ['hash', 'openai', 'ollama'].includes(envProvider)) {
    embedding.provider = envProvider as LaapPluginConfig['embedding']['provider']
    envOverrides.push(`provider=${envProvider}`)
  }
  if (envStr('LAAP_EMBED_BASE_URL')) { embedding.baseUrl = envStr('LAAP_EMBED_BASE_URL')!; envOverrides.push('baseUrl') }
  if (envStr('LAAP_EMBED_MODEL')) { embedding.model = envStr('LAAP_EMBED_MODEL')!; envOverrides.push(`model=${embedding.model}`) }
  if (envDim !== undefined && envDim >= 8) { embedding.dimension = envDim; envOverrides.push(`dimension=${envDim}`) }
  if (envStr('LAAP_EMBED_API_KEY_ENV')) { embedding.apiKeyEnv = envStr('LAAP_EMBED_API_KEY_ENV')!; envOverrides.push('apiKeyEnv') }

  const config: LaapPluginConfig = {
    dbPath: envStr('LAAP_ZVEC_PATH') ?? raw?.dbPath ?? `${homedir()}/.dsh-laap/zvec-memory`,
    sensitivity: envNum('LAAP_SENSITIVITY') ?? raw?.sensitivity ?? 1,
    heartbeatMs: envNum('LAAP_HEARTBEAT_MS') ?? raw?.heartbeatMs ?? 30000,
    consolidateEvery: raw?.consolidateEvery ?? 120,
    saveEvery: raw?.saveEvery ?? 20,
    noveltyThreshold: envNum('LAAP_NOVELTY_THRESHOLD') ?? raw?.noveltyThreshold ?? 0.45,
    autoEpisodic: raw?.autoEpisodic ?? true,
    embedding,
  }
  if (envNum('LAAP_NOVELTY_THRESHOLD') !== undefined) envOverrides.push(`noveltyThreshold=${config.noveltyThreshold}`)
  if (envOverrides.length) log.info(`检测到环境变量覆写：${envOverrides.join('，')}（.env/环境变量优先级高于 patch 配置）`)

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
  } else if (config.embedding.provider === 'ollama') {
    // 本地 Ollama：OpenAI 兼容 /v1/embeddings，无需 API key；需先 ollama pull nomic-embed-text
    const baseUrl = config.embedding.baseUrl || 'http://localhost:11434/v1'
    const model = config.embedding.model && config.embedding.model !== 'dsha256'
      ? config.embedding.model
      : 'nomic-embed-text'
    embed = openaiEmbed({
      baseUrl,
      model,
      apiKey: process.env[config.embedding.apiKeyEnv],
      dimension: config.embedding.dimension,
    })
    dim = config.embedding.dimension
    ctx.logger('laap').info(`嵌入 provider=ollama（${baseUrl}/${model}，${dim} 维）`)
    if (dim === HASH_DIM) {
      ctx.logger('laap').warn(`嵌入 provider=ollama 但 dimension=${dim}（hash 默认值）：nomic-embed-text 实际输出 768 维，维度不匹配会导致写入失败，请在配置中设置 dimension: 768 并清空旧库目录重建`)
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
  ctx.logger('laap').info(`意识内核已启动（zvec: ${config.dbPath}｜嵌入: ${config.embedding.provider}${config.embedding.provider === 'hash' ? '' : `/${config.embedding.model}`}）`)
}

