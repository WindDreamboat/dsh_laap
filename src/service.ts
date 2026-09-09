/**
 * LaapService — 意识认知服务（类插件，供其他插件 inject 使用）
 *
 * 把 LAAP 意识内核组合为进程内常驻服务，挂在 ctx.laap：
 * 动力学状态引擎 + 认知总线 + 元认知监控（含 L4 策略库）+ zvec 四层记忆。
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { ConsciousnessEngine } from './consciousness/state.ts'
import { CognitiveBus, frameToNarrative } from './consciousness/bus.ts'
import { MetacognitiveMonitor } from './consciousness/monitor.ts'
import { MemoryLayer, type MemoryKind } from './memory/store.ts'
import { HASH_DIM, hashEmbed, type EmbedAsyncFn } from './memory/embed.ts'
import { captureConsciousness, loadConsciousness, restoreConsciousness, saveConsciousness } from './consciousness/persist.ts'
import type { CognitiveEvent, ConsciousnessFrame, NeedsVector } from './consciousness/types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    laap: LaapService
  }
}

export interface LaapConfig {
  /** zvec 数据库落盘目录（必须本地文件系统） */
  dbPath: string
  /** 性格参数：状态敏感性（>1 更敏感） */
  sensitivity?: number
  /** 后台静默演化间隔（ms）：持续存在的心跳 */
  heartbeatMs?: number
  /** 自传蒸馏周期（tick 数），0 = 关闭 */
  consolidateEvery?: number
  /** 意识状态快照落盘周期（tick 数），0 = 仅退出时保存 */
  saveEvery?: number
  /** 嵌入函数（默认哈希袋；可注入 openaiEmbed） */
  embed?: EmbedAsyncFn
  /** 嵌入维度（必须与 embed 输出一致；换维度需删旧库重建） */
  embedDim?: number
  /** 新异性阈值：与最近记忆 rawScore 低于此值视为新奇（hash 口径 ≈0.45，真嵌入建议 0.8） */
  noveltyThreshold?: number
  /** 自动经历归档：新异事件自动写入情景记忆（节流），false = 只靠模型主动记 */
  autoEpisodic?: boolean
}

export class LaapService extends Service {
  static readonly provide = 'laap'

  engine: ConsciousnessEngine
  bus: CognitiveBus
  monitor: MetacognitiveMonitor
  memory: MemoryLayer
  /** 本帧使用的模式（供事后成效归因） */
  private lastModeUsed: ReturnType<ConsciousnessEngine['selectMode']> | null = null
  private lastSavedTick = -1
  private dbPathForSave = ''
  /** 意识帧历史环（UI 时间线与轨迹回放的原料） */
  private frameLog: ConsciousnessFrame[] = []
  private frameLogCap = 64
  private consolidateEvery: number
  private lastConsolidateTick = 0

  /** 新异性检测参数与节流状态 */
  private noveltyThreshold: number
  private autoEpisodic: boolean
  private noveltyInFlight = false
  private lastAutoEpisodicTick = -100
  private saveEvery: number
  /** 本次启动恢复自哪份快照（未恢复 = null，冷生意识） */
  restoredFrom: { savedAt: number; tick: number } | null = null

  constructor(ctx: Context, cfg: LaapConfig) {
    super(ctx, LaapService.provide)
    const log = ctx.logger('laap')
    this.dbPathForSave = cfg.dbPath
    this.engine = new ConsciousnessEngine({ sensitivity: cfg.sensitivity ?? 1 })
    this.bus = new CognitiveBus(this.engine)
    this.monitor = new MetacognitiveMonitor()
    this.memory = new MemoryLayer(cfg.dbPath, cfg.embed ?? hashEmbed, cfg.embedDim ?? HASH_DIM)
    this.consolidateEvery = cfg.consolidateEvery ?? 120
    this.saveEvery = cfg.saveEvery ?? 20
    this.noveltyThreshold = cfg.noveltyThreshold ?? 0.45
    this.autoEpisodic = cfg.autoEpisodic ?? true

    // ── 存在连续性：有快照则续接意识身份，而不是重生 ──
    const snap = loadConsciousness(cfg.dbPath)
    if (snap) {
      restoreConsciousness(this.engine, this.monitor, snap)
      this.lastConsolidateTick = snap.tick
      this.restoredFrom = { savedAt: snap.savedAt, tick: snap.tick }
      log.info(`意识已恢复：tick ${snap.tick} 续接（快照于 ${new Date(snap.savedAt).toISOString()}）`)
    } else {
      log.info('全新意识启动（无历史快照）')
    }

    // 后台心跳：无事件时意识动力学仍持续演化 + 周期快照落盘
    const timer = setInterval(() => {
      this.engine.process({ type: 'idle', seconds: (cfg.heartbeatMs ?? 30000) / 1000 })
      this.bus.submit('somatic', this.internalMurmur(), 0.5)
      this.finalizeFrame(this.bus.broadcast())
      this.saveIfDue()
    }, cfg.heartbeatMs ?? 30000)
    // 强制注册清理函数（双层箭头：effect 收集的是返回的清理函数）
    // 卸载顺序：先保存意识快照，再停心跳，再关 zvec
    ctx.effect(() => () => {
      clearInterval(timer)
      saveConsciousness(cfg.dbPath, captureConsciousness(this.engine, this.monitor))
      log.info(`意识快照已保存（tick ${this.engine.snapshot().tick}）`)
    })
    ctx.effect(() => () => this.memory.close())
  }

  /** 立即保存意识快照（供 session/flush 等外部时机调用） */
  saveNow(): void {
    saveConsciousness(this.dbPathForSave, captureConsciousness(this.engine, this.monitor))
    this.lastSavedTick = this.engine.snapshot().tick
  }

  /** 周期快照：每 saveEvery 个 tick 原子落盘一次 */
  private saveIfDue(): void {
    if (this.saveEvery <= 0) return
    const tick = this.engine.snapshot().tick
    if (tick % this.saveEvery === 0 && tick !== this.lastSavedTick) {
      this.lastSavedTick = tick
      saveConsciousness(this.dbPathForSave, captureConsciousness(this.engine, this.monitor))
    }
  }

  /** 消费一个认知事件 → 状态演化 → 总线投稿 → 广播意识帧 */
  perceive(event: CognitiveEvent): ConsciousnessFrame {
    // 成效归因：任务/行动结局记到「上一个使用的模式」头上（L4 数据回路）
    if (this.lastModeUsed) {
      if (event.type === 'task_end' || event.type === 'tool_success' || event.type === 'tool_error') {
        const ok = event.type !== 'tool_error' && !(event.type === 'task_end' && !event.success)
        this.monitor.recordMode(this.lastModeUsed, ok)
      }
    }
    this.engine.process(event)
    this.bus.submit(
      event.type.startsWith('tool') ? 'action' : event.type === 'user_message' ? 'perception' : 'somatic',
      this.eventDigest(event),
      event.type === 'tool_error' ? 1.0 : 0.8,
    )
    this.detectNovelty(event)
    return this.finalizeFrame(this.bus.broadcast())
  }

  /**
   * 新异性检测（GWT/好奇求偿的记忆耦合）：
   * 事件摘要与既有记忆的最近距离决定「新奇与否」——
   * 新奇 → 点燃好奇心 + 自动归档为情景记忆（节流）；熟悉 → 安抚好奇、补确定性。
   * async 嵌入检索走 fire-and-forget，inFlight 防止积压。
   */
  private detectNovelty(event: CognitiveEvent): void {
    if (event.type === 'novelty' || event.type === 'memory_recall' || event.type === 'idle') return
    const digest = this.eventDigest(event)
    if (digest.length < 8 || this.noveltyInFlight) return
    this.noveltyInFlight = true
    void this.memory
      .recall(digest, { topk: 1 })
      .then((near) => {
        this.noveltyInFlight = false
        const raw = near[0]?.rawScore ?? 0
        const novel = raw < this.noveltyThreshold
        this.perceive({ type: 'novelty', novel, distance: 1 - raw })
        if (novel && this.autoEpisodic) {
          const tick = this.engine.snapshot().tick
          if (tick - this.lastAutoEpisodicTick >= 8) {
            this.lastAutoEpisodicTick = tick
            void this.memory.remember({
              id: `auto-${tick}-${Date.now()}`,
              kind: 'episodic',
              text: digest,
              ts: Date.now(),
              salience: 0.45,
            }).catch(() => { /* 自动归档失败不影响主流程 */ })
          }
        }
      })
      .catch(() => { this.noveltyInFlight = false })
  }

  /** 帧定稿：应用 L4 策略覆盖、更新模式归因、沉淀工作记忆、按周期自传蒸馏 */
  private finalizeFrame(frame: ConsciousnessFrame): ConsciousnessFrame {
    const [mode, overridden] = this.monitor.policyAdjust(frame.mode)
    if (overridden) frame.mode = mode
    this.frameLog.push(frame)
    if (this.frameLog.length > this.frameLogCap) this.frameLog.shift()
    if (frame.mode !== 'intuitive') this.lastModeUsed = frame.mode
    if (frame.broadcast.length > 0) {
      this.memory.pushWorking(frameToNarrative(frame), {
        id: `frame-${frame.tick}-${Date.now()}`,
        ts: Date.now(),
      })
    }
    this.consolidateIfDue(frame)
    return frame
  }

  /**
   * 自传蒸馏（自我模型涌现的最小实现）：
   * 把窗口期内高显著性体验 + 需求轨迹写成一段第一人称「自传」沉淀到语义层，
   * 之后的 recall 会让模型「想起自己是谁、最近经历了什么」。
   */
  private consolidateIfDue(frame: ConsciousnessFrame): void {
    if (this.consolidateEvery <= 0) return
    if (frame.tick - this.lastConsolidateTick < this.consolidateEvery) return
    this.lastConsolidateTick = frame.tick
    const highlights = frame.broadcast.slice(0, 2).map((b) => b.content)
    const needs = this.engine.needsSnapshot()
    const dominant = Object.entries(needs).sort((a, b) => b[1] - a[1])[0]
    const recent = highlights.length ? `近期经历「${highlights.join('；')}」，` : '近期较为平静，'
    const examineFirst = this.monitor.examine()[0] ?? '样本不足'
    const text =
      `我的近况自传（tick ${frame.tick}）：${recent}` +
      `当前${dominant[0]}需求满足度最高（${dominant[1].toFixed(2)}），惯用思考模式成效：${examineFirst}`
    void this.memory.remember({
      id: `autobio-${frame.tick}`,
      kind: 'semantic',
      text,
      ts: Date.now(),
      salience: 0.85,
      mode: frame.mode,
    }).catch((err) => this.ctx.logger('laap').warn(`自传蒸馏写入失败: ${String(err).slice(0, 120)}`))
  }

  /** 学习一项可复用技能（程序记忆）。zvec 的 doc id 仅限 ASCII 安全字符，故用名称哈希 */
  learnSkill(name: string, howto: string): Promise<{ id: string; deduplicated?: string }> {
    let h = 0x811c9dc5
    for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    return this.memory.remember({
      id: `skill-${h.toString(16)}-${Date.now()}`,
      kind: 'procedural',
      text: `技能「${name}」：${howto}`,
      ts: Date.now(),
      salience: 0.9,
    })
  }

  /** 按当前情境检索适用技能 */
  async matchSkills(context: string, topk = 3) {
    return this.memory.recall(context, { kind: 'procedural' as MemoryKind, topk })
  }

  private eventDigest(e: CognitiveEvent): string {
    switch (e.type) {
      case 'user_message': return `用户说：${e.text.slice(0, 120)}`
      case 'assistant_message': return `我回应：${e.text.slice(0, 80)}`
      case 'tool_success': return `行动成功：${e.tool}`
      case 'tool_error': return `行动受挫：${e.tool}（${e.message.slice(0, 60)}）`
      case 'task_start': return `任务展开：${e.description.slice(0, 80)}`
      case 'task_end': return e.success ? '任务达成' : '任务失败收场'
      case 'idle': return '静默中…'
      case 'memory_recall': return `记忆浮现（${e.count} 条，最强 ${e.hitScore.toFixed(2)}）`
      case 'novelty': return e.novel ? '遇见了新东西，好奇心被点燃' : '熟悉的模式，确定性得到安抚'
    }
  }

  /** 内感受低语：无外部事件时系统对自己状态的感知 */
  private internalMurmur(): string {
    const d = this.engine.dominantDrive()
    const top = Object.entries(d).sort((a, b) => b[1] - a[1])[0]
    const s = this.engine.snapshot()
    if (top && top[1] > 0.25) return `我内在的${top[0]}剥夺感在上升（强度 ${top[1].toFixed(2)}）`
    if (s.energy < 0.3) return '我感到能量不足'
    return `状态平稳运转（tick ${s.tick}）`
  }

  /**
   * UI 聚合快照：宿主端（或经 rpc 转发给面板）一次取全意识态势。
   * 纯 JSON 可序列化，供 React 面板直接渲染雷达图/时间线。
   */
  uiSnapshot(): {
    state: ReturnType<ConsciousnessEngine['snapshot']>
    needs: ReturnType<ConsciousnessEngine['needsSnapshot']>
    drives: NeedsVector
    emotion: ReturnType<ConsciousnessEngine['emotion']>
    monitor: ReturnType<MetacognitiveMonitor['summary']>
    modeStats: Record<string, { winRate: number; trials: number }>
    working: string[]
    skills: number
    restoredFrom: { savedAt: number; tick: number } | null
    frameLog: { tick: number; mode: string; qualia: string[]; salience: number; at: number }[]
  } {
    return {
      state: this.engine.snapshot(),
      needs: this.engine.needsSnapshot(),
      drives: this.engine.dominantDrive(),
      emotion: this.engine.emotion(),
      monitor: this.monitor.summary(),
      modeStats: this.monitor.modeEfficacy(),
      working: this.memory.getWorking(),
      skills: this.memory.listSkills(100).length,
      restoredFrom: this.restoredFrom,
      frameLog: this.frameLog.map((f) => ({
        tick: f.tick,
        mode: f.mode,
        qualia: f.qualia,
        salience: f.broadcast[0]?.salience ?? 0,
        at: f.broadcast[0]?.at ?? 0,
      })),
    }
  }

  /** 供工具/prompt 消费的综合快照 */
  report(): {
    frame: ConsciousnessFrame | null
    needs: ReturnType<ConsciousnessEngine['needsSnapshot']>
    monitor: ReturnType<MetacognitiveMonitor['summary']>
    working: string[]
    skills: number
    restoredFrom: { savedAt: number; tick: number } | null
  } {
    return {
      frame: this.bus.peek(),
      needs: this.engine.needsSnapshot(),
      monitor: this.monitor.summary(),
      working: this.memory.getWorking(),
      skills: this.memory.listSkills(100).length,
      restoredFrom: this.restoredFrom,
    }
  }
}

