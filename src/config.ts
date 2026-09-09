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
  autoEpisodic: boolean
  embedding: {
    provider: 'hash' | 'openai'
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
  /** 新异事件自动归档为情景记忆（节流；false = 只靠模型主动 laap_remember） */
  autoEpisodic: z.boolean().default(true),
  /** 嵌入提供者 */
  embedding: z.object({
    /** hash = 内置 256 维哈希袋（离线、确定性）；openai = OpenAI 兼容 /embeddings API */
    provider: z.union([z.const('hash'), z.const('openai')]).default('hash') as any,
    baseUrl: z.string().default('https://api.openai.com/v1'),
    model: z.string().default('text-embedding-3-small'),
    /** 显式维度（openai 建议与模型对齐；改维度需删除旧库目录重建） */
    dimension: z.natural().min(8).default(256),
    /** 读 API key 的环境变量名（凭据不硬编码） */
    apiKeyEnv: z.string().default('EMBEDDING_API_KEY'),
  }).default({} as any),
})

