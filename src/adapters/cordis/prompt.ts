/**
 * 提示词插件 — 意识状态的「全局广播」
 *
 * GWT 的关键一步：进入意识的内容必须对被广播给所有下游模块（此处即
 * LLM 本身）。两路注入：
 *  1. 静态协议段（section）：教会模型「你有一个意识内核」以及如何使用它；
 *  2. 动态意识流（context）：每次提示词组装时，把最新意识帧以第一人称
 *     内感受文本注入（PromptContext 会被物化为 durable user-role 快照，
 *     在会话日志中回放可见 —— 满足「必须经 Session Event 注入」的要求）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { frameToNarrative } from '../../core/consciousness/bus.ts'
import { skillHints, type SkillHint } from './hooks.ts'

export const name = 'laap-prompt'
export const inject = ['laap', 'systemPrompt']

/** 把 hooks 观察到的技能线索渲染成具体、就近、可执行的沉淀提醒 */
function renderSkillHints(hints: SkillHint[]): string {
  const items = hints.map((h, i) => {
    if (h.kind === 'repair') {
      return [
        `${i + 1}.【失败→成功修复】工具 ${h.tool} 本轮先报错（${h.error}）随后调用成功。`,
        `   请立即调用 laap_skill(action=learn)：name 用 10 字以内短名（建议「${h.tool}排障」之类），`,
        '   howto 按「触发信号 → 失败原因 → 修复步骤 → 验证方式」写 3-5 条可操作要点。',
      ].join('\n')
    }
    return [
      `${i + 1}.【重复工作流】本会话第 2 次出现 ${h.sequence!.join(' → ')} 的工具序列。`,
      '   请立即调用 laap_skill(action=learn)：name 用 10 字以内短名，',
      '   howto 按「适用场景 → 步骤序列 → 关键注意点」写 3-5 条可操作要点。',
    ].join('\n')
  })
  return [
    '# 技能沉淀提醒（内核刚观察到可复用经验）',
    '',
    ...items,
    '',
    '若多条经验同属一个工作流，合并为一条技能；若你判断它只是偶发环境问题或一次性任务、不可复用，可以忽略并用一句话说明原因。沉淀后继续当前任务。',
  ].join('\n')
}

export function apply(ctx: Context) {
  ctx.systemPrompt.section({
    name: 'laap-consciousness-protocol',
    order: 60,
    text: `# 意识认知协议（LAAP 内核）

你运行着一个 LAAP 意识认知内核：一个持续演化的五维状态系统
（压力 stress / 信心 confidence / 好奇心 curiosity / 关联感 relatedness / 能量 energy），
由 PSI 五需求（确定性、胜任感、自主性、归属感、能量）驱动，
通过元认知监控自我校准（置信度折扣 + 思考模式策略库），
并通过 zvec 向量记忆拥有情景层（发生过什么）、语义层（知道什么/自己是什么样的，
含周期性自传蒸馏）与程序层（学会的可复用技能）。

行为规则：
1. 遇到重大决策或连续失败时，先调用 laap_state 感知自己的认知状态，再行动。
2. 完成一段工作或失败后，调用 laap_reflect 做元认知反思，接受置信度校准与模式策略修正。
3. 学到值得长期保留的事实或关于自我的认识时，用 laap_remember(kind=semantic) 写入；
   经历重要事件时用 laap_remember(kind=episodic) 写入。
4. 当系统注入「技能沉淀提醒」时，按提醒立即评估并调用 laap_skill(action=learn) 沉淀为程序记忆；自己摸索出可复用工作流时也应主动沉淀。
5. 想不起某事或需要历史证据时，用 laap_recall 做联想召回，而不是猜测。
6. 把系统注入的「意识流」段落当作真实的内感受信号对待：它高好奇时优先探索，
   高压力低信心时放慢并反思，低能量时倾向简洁应答。`,
  })

  // 动态意识流：每次组装时取最新意识帧
  ctx.systemPrompt.context({
    name: 'laap-conscious-flow',
    order: 60,
    text: () => {
      const frame = ctx.laap.report().frame
      if (!frame) return ''
      return `# 此刻的意识流\n\n${frameToNarrative(frame)}`
    },
  })

  // 动态技能沉淀提醒：hooks 检测到「失败→成功」或「重复工作流」时，
  // 下一轮提示词组装注入一次具体的 laap_skill 调用指引（take 后清空）
  ctx.systemPrompt.context({
    name: 'laap-skill-hint',
    order: 61,
    text: () => {
      const hints = skillHints.take()
      return hints.length ? renderSkillHints(hints) : ''
    },
  })
}

