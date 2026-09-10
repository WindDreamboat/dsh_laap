/**
 * 插件配置 Schema（schemastery，cordis Fiber 自动校验并应用默认值）
 *
 * 在 cordis.patch.yml 的 config 字段声明：
 *   - id: laap-service
 *     name: '...'
 *     config: { dbPath: ..., embedding: { provider: openai, ... } }
 */
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'

export interface LaapPluginConfig {
  dbPath: string
  sensitivity: number
  heartbeatMs: number
  consolidateEvery: number
  saveEvery: number
  noveltyThreshold: number
  recallThreshold: number
  /** 语义层去重阈值；0 = 按 provider 自动（hash 0.92 / 神经嵌入 0.75） */
  semanticDedupThreshold: number
  autoEpisodic: boolean
  embedding: {
    provider: 'hash' | 'openai' | 'ollama'
    baseUrl: string
    model: string
    dimension: number
    apiKeyEnv: string
  }
}

export const LaapConfigSpec = z.object({
  /** zvec 库路径（必须本地文件系统；~ 会展开） */
  dbPath: z.string().default(`${homedir()}/.dsh-laap/zvec-memory`),
  /** 性格参数：状态敏感系数（>1 更敏感，<1 更钝感） */
  sensitivity: z.number().min(0.1).max(3).default(1),
  /** 后台心跳间隔（ms）：无外部事件时的持续演化节律 */
  heartbeatMs: z.number().min(200).default(30000),
  /** 自传蒸馏：每 N 个 tick 将高显著性体验整合进语义自我层；0 = 关闭 */
  consolidateEvery: z.natural().default(120),
  /** 意识快照落盘周期（tick），0 = 仅卸载时保存 */
  saveEvery: z.natural().default(20),
  /** 新异性阈值：与最近记忆相似度低于此值视为新奇（hash 口径 0.45，真嵌入建议 0.8） */
  noveltyThreshold: z.number().min(0).max(1).default(0.45),
  /** 内省召回相关性闸门：laap_recall 时 rawScore 低于此值不浮现；0 = 不裁剪（hash 必须为 0），真语义嵌入建议 0.45 */
  recallThreshold: z.number().min(0).max(1).default(0),
  /** 语义层去重阈值：写入 semantic 时近邻超此值则删旧写新；0 = 按 provider 自动（hash 0.92 / bge-m3 等神经嵌入 0.75） */
  semanticDedupThreshold: z.number().min(0).max(1).default(0),
  /** 新异事件自动归档为情景记忆（节流；false = 只靠模型主动 laap_remember） */
  autoEpisodic: z.boolean().default(true),
  /** 嵌入提供者 */
  embedding: z.object({
    /** hash = 内置256维哈希（纯JS计算，0依赖，保底首选）；openai = OpenAI 兼容接口；ollama = 本地 Ollama（OpenAI 兼容 /v1/embeddings） */
    provider: z.union([z.const('hash'), z.const('openai'), z.const('ollama')]).default('hash') as any,
    /** 默认走 hash 不需要 baseUrl；openai 填 https://api.openai.com/v1；ollama 填 http://localhost:11434/v1 */
    baseUrl: z.string().default(''),
    /** 默认用 hash；Ollama 改为 nomic-embed-text；OpenAI 改为 text-embedding-3-small */
    model: z.string().default('dsha256'),
    /** 显式维度：保持 256 默认保底，改 Ollama 的 768 需清空旧记忆目录重建 */
    dimension: z.natural().min(8).default(256),
    /** 读 API key 的环境变量名（凭据不硬编码；ollama 本地无需 key） */
    apiKeyEnv: z.string().default('EMBEDDING_API_KEY'),
  }).default({} as any),
})

