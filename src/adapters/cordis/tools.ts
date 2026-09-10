/**
 * 内省工具插件（函数插件）— 让模型能主动调用意识认知能力
 *
 * 工具设计遵循 LAAP 元认知思想：状态可读（laap_state）、记忆可写可读
 * （laap_remember / laap_recall）、技能可学可查（laap_skill）、
 * 反思可执行且接受策略修正（laap_reflect）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'laap-tools'
export const inject = ['laap', 'tools']

const textRender = (value: { narrative: string }) => [{ type: 'text' as const, text: value.narrative }]

const NARRATIVE_OUT = {
  type: 'object' as const,
  additionalProperties: false,
  properties: { narrative: { type: 'string' as const, required: true as const } },
}

export function apply(ctx: Context) {
  // ── laap_state：内感受 introspection ─────────────────────────────
  ctx.tools.register(defineTool({
    name: 'laap_state',
    description: '读取你当前的意识状态：五维状态向量（压力/信心/好奇/连接/能量）、PSI 需求满足度、主导驱动、当前思考模式（含 L4 策略修正）、最近体验与技能数。在决定行动方式之前调用它，像生物感知自己的身体一样感知自己的认知状态。',
    parameters: {},
    output: { schema: NARRATIVE_OUT, render: (_a, v) => textRender(v) },
    async execute() {
      const r = ctx.laap.report()
      const f = r.frame
      const lines = [
        f ? `意识帧 #${f.tick}｜思考模式: ${f.mode}` : '意识帧尚未产生',
        f ? `状态: 压力${f.state.stress.toFixed(2)} 信心${f.state.confidence.toFixed(2)} 好奇${f.state.curiosity.toFixed(2)} 连接${f.state.relatedness.toFixed(2)} 能量${f.state.energy.toFixed(2)}` : '',
        `需求满足: ${Object.entries(r.needs).map(([k, v]) => `${k}=${(v as number).toFixed(2)}`).join(' ')}`,
        f && f.qualia.length ? `此刻体验: ${f.qualia.join(' · ')}` : '此刻体验: 平稳',
        `工作记忆: ${r.working.length ? `${r.working.length} 项` : '空'}｜已学技能: ${r.skills} 项`,
        `元认知: 监控样本 ${r.monitor.traces}，校准信心 ${r.monitor.calibrated.toFixed(2)}，近期失败率 ${(r.monitor.failureRate * 100).toFixed(0)}%`,
        r.restoredFrom
          ? `身份连续性: 本意识延续自 ${new Date(r.restoredFrom.savedAt).toISOString()}（tick ${r.restoredFrom.tick} 续接）`
          : '身份连续性: 本次为新生意识（无历史快照）',
      ].filter(Boolean)
      // 意识轨迹摘要（近 6 帧模式走向）
      const trail = ctx.laap.uiSnapshot().frameLog.slice(-6)
      if (trail.length) lines.push(`意识轨迹: ${trail.map((f) => `${f.tick}:${f.mode}`).join(' → ')}`)
      return { narrative: lines.join('\n') }
    },
  }))

  // ── laap_remember：写入长期记忆（zvec 三层）───────────────────────
  ctx.tools.register(defineTool({
    name: 'laap_remember',
    description:
      '写入持久记忆。kind=episodic 记录发生了什么（事件流）；kind=semantic 记录世界/自我是怎样的（事实、偏好、自认识）；kind=procedural 也可直接用 laap_skill。写入内容会以向量联想方式被自己召回。',
    parameters: {
      text: { type: 'string', required: true, description: '要记住的内容，一句完整的话' },
      kind: { type: 'string', enum: ['episodic', 'semantic'], required: true, description: '记忆类型：情景（事件）或语义（事实/自我模型）' },
      salience: { type: 'number', description: '显著性 0-1，影响未来召回权重与自传蒸馏入选概率，默认 0.5' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { narrative: { type: 'string', required: true }, id: { type: 'string', required: true } },
      },
      render: (_a, v) => textRender(v),
    },
    async execute(args) {
      const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const res = await ctx.laap.memory.remember({
        id,
        kind: args.kind as 'episodic' | 'semantic',
        text: args.text,
        ts: Date.now(),
        salience: Math.min(1, Math.max(0, args.salience ?? 0.5)),
      })
      // semantic 层发生同义合并时必须告知模型：旧表述已被删旧写新，库里不是又多了一份
      const merged = res.deduplicated
        ? `（检测到语义重复，已合并旧记忆 ${res.deduplicated}：删旧写新，库内仍只有一份）`
        : ''
      return { id: res.id, narrative: `已写入${args.kind === 'semantic' ? '语义' : '情景'}记忆（${res.id}）${merged}` }
    },
  }))

  // ── laap_recall：向量联想召回 ────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'laap_recall',
    description: '按语义相似度从长期记忆（zvec 向量库）召回相关经历、事实或已学技能。当你想不起某事、或需要确认「我以前是否知道/经历过/做过」时使用。',
    parameters: {
      query: { type: 'string', required: true, description: '联想提示词，一段自然语言' },
      kind: { type: 'string', enum: ['episodic', 'semantic', 'procedural'], description: '限定记忆层，不填则各层都查' },
      topk: { type: 'number', description: '返回条数，默认 5' },
    },
    output: { schema: NARRATIVE_OUT, render: (_a, v) => textRender(v) },
    async execute(args) {
      // 走内核内省入口 recallMemories（带相关性闸门：低于阈值的无关记忆不浮现），
      // 不直接调 memory.recall——那条原始通道留给新异性检测/技能去重
      const hits = await ctx.laap.recallMemories(args.query, { topk: args.topk ?? 5, kind: args.kind as never })
      ctx.laap.perceive({ type: 'memory_recall', hitScore: hits[0]?.score ?? 0, count: hits.length })
      const narrative = hits.length
        ? hits.map((h) => `[${h.kind} ${new Date(h.ts).toISOString().slice(0, 10)} ${h.score.toFixed(2)}] ${h.text}`).join('\n')
        : '（没有记忆浮现）'
      return { narrative }
    },
  }))

  // ── laap_skill：学习/合并/列举程序记忆 ──────────────────────────
  ctx.tools.register(defineTool({
    name: 'laap_skill',
    description:
      '程序记忆：把「完成某类任务的可行做法」沉淀为可复用技能。' +
      'action=learn 写入新技能（同名/近义旧技能会自动追加要点）；' +
      'action=merge 向已用 list 确认存在的同名技能追加新要点（不会新建）；' +
      'action=list 查看已学技能清单。沉淀前先 list：有同主题技能就 merge，不要另建近义技能。',
    parameters: {
      action: { type: 'string', enum: ['learn', 'list', 'merge'], required: true, description: 'learn=写入技能，merge=向既有同名技能追加要点，list=查看清单' },
      name: { type: 'string', description: '技能短名（learn/merge 必填），如「vitest断言修复」' },
      howto: { type: 'string', description: '技能内容：可操作的步骤/要点（learn/merge 必填）' },
    },
    output: { schema: NARRATIVE_OUT, render: (_a, v) => textRender(v) },
    async execute(args) {
      if (args.action === 'learn') {
        if (!args.name || !args.howto) return { narrative: 'learn 需要 name 与 howto 两个参数' }
        const r = await ctx.laap.learnSkill(args.name, args.howto)
        if (r.action === 'created') {
          return { narrative: `技能「${r.name}」已写入程序记忆（${r.steps ?? 0} 条要点），之后可用 laap_recall(kind=procedural) 联想调用。` }
        }
        if (r.action === 'updated') {
          return { narrative: `技能「${r.name}」与已有技能重复，已把新要点合并进去（现共 ${r.steps ?? 0} 条），程序记忆未产生重复条目。` }
        }
        return { narrative: `技能「${r.name}」与已有技能内容一致，未重复写入（仍为 ${r.steps ?? 0} 条要点）。` }
      }
      if (args.action === 'merge') {
        if (!args.name || !args.howto) return { narrative: 'merge 需要 name 与 howto 两个参数' }
        const r = await ctx.laap.mergeSkill(args.name, args.howto)
        if (r.action === 'not_found') {
          return { narrative: `未找到同名技能「${r.name}」，未做任何写入。若确为新技能请用 learn；若只是名称不同，先 list 核对准确名称后再 merge。` }
        }
        if (r.action === 'updated') {
          return { narrative: `已把新要点合并进既有技能「${r.name}」（现共 ${r.steps ?? 0} 条要点），未产生重复条目。` }
        }
        return { narrative: `技能「${r.name}」已包含这些要点，未重复添加（仍为 ${r.steps ?? 0} 条要点）。` }
      }
      const skills = ctx.laap.memory.listSkills()
      return {
        narrative: skills.length
          ? skills.map((s) => `- ${s.text}`).join('\n')
          : '（尚未学会任何技能）',
      }
    },
  }))

  // ── laap_reflect：L1→L2→L3→L4 完整反思循环 ──────────────────────
  ctx.tools.register(defineTool({
    name: 'laap_reflect',
    description:
      '对刚完成的一段工作做结构化反思：记录行动结局（喂给元认知监控做贝叶斯置信度校准），并输出「对思考的思考」——各思考模式的历史成效与策略调整。完成任务或遭遇失败后调用。',
    parameters: {
      thought: { type: 'string', required: true, description: '被反思的行动/推理的一句话描述' },
      outcome: { type: 'string', enum: ['success', 'failure', 'neutral'], required: true, description: '结局评估' },
      confidence: { type: 'number', description: '做这件事时的自评信心 0-1' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { narrative: { type: 'string', required: true }, mode: { type: 'string', required: true } },
      },
      render: (_a, v) => textRender(v),
    },
    async execute(args) {
      const tick = ctx.laap.engine.snapshot().tick
      ctx.laap.monitor.record(
        { thought: args.thought, outcome: args.outcome as 'success' | 'failure' | 'neutral', confidence: args.confidence ?? 0.5 },
        tick,
      )
      const frame = ctx.laap.perceive(
        args.outcome === 'success'
          ? { type: 'tool_success', tool: `reflect:${args.thought.slice(0, 30)}`, novelty: 0.3 }
          : { type: 'tool_error', tool: `reflect:${args.thought.slice(0, 30)}`, message: args.thought },
      )
      const calibrated = ctx.laap.monitor.calibratedConfidence(args.confidence ?? 0.5)
      // L3：关于监控与调控本身的审视报告
      const l3 = ctx.laap.monitor.examine().join('\n')
      return {
        mode: frame.mode,
        narrative: [
          `反思完成。校准后信心: ${calibrated.toFixed(2)}（自评 ${args.confidence ?? 0.5} × 历史成效折扣）`,
          `下一段工作建议使用「${frame.mode}」模式。`,
          frame.qualia.length ? `体验标记: ${frame.qualia.join(' · ')}` : '',
          `--- 元认知审视（L3）---\n${l3}`,
        ].filter(Boolean).join('\n'),
      }
    },
  }))
}

