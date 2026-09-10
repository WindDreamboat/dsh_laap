/**
 * 第十轮修复固化（真实自验发现的四个问题）：
 *
 * A. 帧归档门槛：仅承载外部通道（perception/action）的帧挤出工作环时
 *    沉淀为情景记忆；纯内感受帧（心跳/助手发言/任务状态/novelty 回灌）
 *    挤出即弃——旧实现稳态下每帧落库，情景层被状态流水账淹没。
 *    归档意图属于入环项自己（平行数组），外部帧被后续内省帧挤出也不丢。
 * B. episodicCap：情景记忆容量上界，超限 FIFO 淘汰最旧；启动重建索引并 prune。
 * C. 内省召回分层闸门：episodic 闸门 = recallThreshold + 0.15，
 *    防止用户指令原文被帧存档后造成的自指命中（实测自指 0.54~0.55、真事 0.63）。
 * D. hooks 入流过滤：user/message 仅 source.kind='user' 才感知
 *    （dsh 注入的 runtime-context 快照 source.kind='plugin'）；
 *    工具错误对象归一化（{code,message} 不再变成 [object Object]）。
 *
 * 用确定性合成 4 维向量精确控制余弦相似度，不依赖 Ollama。
 * 运行：node --experimental-strip-types test/frame-guard.ts
 */
import { Context } from '@deepseek-ai/cordis'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { MemoryLayer } from '../src/core/memory/store.ts'
import type { EmbedAsyncFn } from '../src/core/memory/embed.ts'
import { createKernel, silentLogger, frameToNarrative, statePath } from '../src/core/index.ts'
import * as laapService from '../src/adapters/cordis/service-plugin.ts'
import * as laapHooks from '../src/adapters/cordis/hooks.ts'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`断言失败: ${msg}`)
  passed++
  console.log(`✔ ${msg}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Windows 下 zvec mmap 句柄 close 后延迟释放，删除需重试 */
const rm = (p: string) => rmSync(p, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
const countKind = (col: MemoryLayer, kind: string) => {
  let n = 0
  for (const d of (col as any).col.iterDocsSync({})) {
    if ((d as any).fields?.kind === kind) n++
  }
  return n
}

// ── 合成嵌入：查询 Q/A 与 EP_HI 完全同向（1.0）；与 AP 余弦 0.78 ──
const A = [1, 0, 0, 0]
const AP = [0.78, Math.sqrt(1 - 0.78 * 0.78), 0, 0]
const O = [0, 0, 0, 1]
const B = [0.6, 0, 0.8, 0] // 与 O 正交：两条 semantic 测试事实不得被语义去重合并
const synthEmbed: EmbedAsyncFn = async (texts: string[]) =>
  texts.map((t) =>
    t.startsWith('Q') || t.startsWith('EPHI') ? A
      : t.startsWith('MID') || t.startsWith('EPLO') ? AP
        : t.includes('偏好事实二') ? B : O)

const now = Date.now()
const DB_FRAME = `${tmpdir()}/laap-frame-${now}`
const DB_PUSH = `${tmpdir()}/laap-push-${now}`
const DB_CAP = `${tmpdir()}/laap-cap-${now}`
const DB_UNCAPPED = `${tmpdir()}/laap-uncap-${now}`
const DB_GATE = `${tmpdir()}/laap-gate-${now}`
const DB_HOOK = `${tmpdir()}/laap-hook-${now}`
const ALL_DBS = [DB_FRAME, DB_PUSH, DB_CAP, DB_UNCAPPED, DB_GATE, DB_HOOK]

let exitCode = 0
try {
  // ══ A. 帧归档门槛 ════════════════════════════════════════════════
  const kf = createKernel(
    { logger: silentLogger },
    {
      dbPath: DB_FRAME, heartbeatMs: 0, consolidateEvery: 9999,
      embed: synthEmbed, embedDim: 4,
      noveltyThreshold: 0,     // raw(0) < 0 永不成立 → 不产生 auto-* 归档
      autoEpisodic: false,
    },
  )
  // 1 条真人发言（perception，外部帧，自带归档意图）
  kf.perceive({ type: 'user_message', text: 'Q-请记住：火星蓝纹酥用霜岩藻做馅' })
  // 12 条助手发言：每条产生 1 个 somatic 帧（+1 个 novelty 回灌 somatic 帧），
  // 全部挤出即弃；外部帧被它们挤出时按其自己的标记归档，恰好 1 条
  for (let i = 0; i < 12; i++) {
    kf.perceive({ type: 'assistant_message', text: `MID-助手正在处理第 ${i} 项工作，输出一段足够长的发言以保证该内感受帧通过广播阈值进入工作记忆环。` })
  }
  await sleep(300) // 等 fire-and-forget 归档（embed+insert）落盘
  assert(countKind(kf.memory as any, 'episodic') === 1, '仅 1 个外部帧被归档，24+ 个内感受帧挤出即弃')
  const archived = await kf.memory.recall('Q-火星蓝纹酥', { kind: 'episodic', topk: 1 })
  assert(archived.length === 1 && archived[0].id.startsWith('frame-') && archived[0].text.includes('火星蓝纹酥'),
    '归档的是外部帧自己的叙事，且用其自己的 frame id')
  kf.dispose()
  await sleep(200)

  // A-单元级：pushWorking 归档意图平行数组——带标记项无论被哪类后续项挤出都按自身标记落库
  const ml = new MemoryLayer(DB_PUSH, synthEmbed, 4)
  for (let i = 0; i < 8; i++) ml.pushWorking(`带标记项 ${i}`, { id: `p-${i}`, ts: now + i })
  await sleep(50)
  assert(countKind(ml, 'episodic') === 1, '8 个带标记项入环（容量 7）：仅最旧 1 个挤出归档')
  for (let i = 0; i < 7; i++) ml.pushWorking(`无标记冲刷项 ${i}`) // 挤出剩余 7 个带标记项
  await sleep(50)
  assert(countKind(ml, 'episodic') === 8, '剩余带标记项被无标记项挤出时仍按自身标记归档（共 8 条）')
  for (let i = 0; i < 6; i++) ml.pushWorking(`纯无标记 ${i}`)   // 挤出的全是无标记项
  await sleep(50)
  assert(countKind(ml, 'episodic') === 8, '纯内感受项互相冲刷不再产生任何归档')
  ml.close()
  await sleep(150) // 等 mmap 句柄释放，避免 Windows EPERM

  // ══ B. episodicCap 容量上界 ══════════════════════════════════════
  const cap = new MemoryLayer(DB_CAP, synthEmbed, 4, { episodicCap: 3 })
  for (let i = 0; i < 5; i++) {
    await cap.remember({ id: `c-${i}`, kind: 'episodic', text: `容量测试事件 ${i}`, ts: now + i * 1000, salience: 0.3 })
  }
  assert(countKind(cap, 'episodic') === 3, 'episodicCap=3：写入 5 条后仅保留 3 条')
  const kept = await cap.recall('容量测试事件', { kind: 'episodic', topk: 5 })
  assert(kept.every((h) => Number(h.ts ?? 0) >= now + 2000) && kept.length === 3,
    'FIFO 淘汰：留下的是 ts 最新的 3 条')
  await cap.remember({ id: 's-1', kind: 'semantic', text: '偏好事实一', ts: now, salience: 0.8 })
  await cap.remember({ id: 's-2', kind: 'semantic', text: '偏好事实二', ts: now, salience: 0.8 })
  assert(countKind(cap, 'episodic') === 3 && countKind(cap, 'semantic') === 2,
    '容量上界只管 episodic：semantic 写入不被误淘汰')
  cap.close()
  await sleep(200) // Windows：同路径重开前等 mmap 句柄释放

  // 重启重建：同库以更小 cap=2 重开 → 启动索引重建后立即 prune
  const re = new MemoryLayer(DB_CAP, synthEmbed, 4, { episodicCap: 2 })
  assert(countKind(re, 'episodic') === 2, '重启时按新 cap 立即淘汰超限的最旧情景记忆')
  re.close()
  await sleep(200)

  // cap=0 = 不限制（独立内核默认口径）
  const uncap = new MemoryLayer(DB_UNCAPPED, synthEmbed, 4, { episodicCap: 0 })
  for (let i = 0; i < 10; i++) {
    await uncap.remember({ id: `u-${i}`, kind: 'episodic', text: `无限容量事件 ${i}`, ts: now + i, salience: 0.3 })
  }
  assert(countKind(uncap, 'episodic') === 10, 'episodicCap=0：不限制条数')
  uncap.close()
  await sleep(150)

  // ══ C. 内省召回分层闸门 ══════════════════════════════════════════
  const kg = createKernel(
    { logger: silentLogger },
    { dbPath: DB_GATE, heartbeatMs: 0, consolidateEvery: 9999, embed: synthEmbed, embedDim: 4, recallThreshold: 0.7 },
  )
  await kg.memory.remember({ id: 'ep-lo', kind: 'episodic', text: 'EPLO-用户刚下达的指令原文（被帧存档）', ts: now, salience: 0.3 }) // 与 Q 余弦 0.78
  await kg.memory.remember({ id: 'ep-hi', kind: 'episodic', text: 'EPHI-去年秋天在京都看红叶的真实经历', ts: now, salience: 0.5 })   // 与 Q 余弦 1.0
  await kg.memory.remember({ id: 'sem-mid', kind: 'semantic', text: 'MID-用户偏好简洁回答的自我事实', ts: now, salience: 0.8 })     // 与 Q 余弦 0.78
  const surfaced = await kg.recallMemories('Q-随便一个查询', { topk: 5 })
  const ids = surfaced.map((h) => h.id).sort()
  assert(ids.includes('ep-hi'), 'episodic 1.0 高相关：过 0.85 情景闸门浮现')
  assert(ids.includes('sem-mid'), 'semantic 0.78：过 0.70 语义闸门浮现')
  assert(!ids.includes('ep-lo'), 'episodic 0.78 自指命中：被 0.85 情景闸门拦截（指令帧不再污染回忆）')
  kg.dispose()
  await sleep(100)

  // ══ D. hooks：source 过滤 + 错误归一化（真实 Cordis 宿主）═════════
  const ctx = new Context()
  const fiber = await ctx.plugin(laapService, { dbPath: DB_HOOK, heartbeatMs: 200, episodicCap: 0 })
  await ctx.plugin(laapHooks)
  const tickOf = () => ctx.laap.engine.snapshot().tick

  const t0 = tickOf()
  ctx.emit('session/event', {} as any, { type: 'user/message', data: { text: '真人说的话，必须被感知', source: { kind: 'user' } } } as any)
  assert(tickOf() === t0 + 1, "source.kind='user'：正常产生意识刺激")

  const t1 = tickOf()
  ctx.emit('session/event', {} as any, {
    type: 'user/message',
    data: { text: 'Current runtime context. This snapshot supersedes previous ones. 插件注入快照', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } },
  } as any)
  ctx.emit('session/event', {} as any, { type: 'user/message', data: { text: '没有 source 字段的旧形态消息' } } as any)
  ctx.emit('session/event', {} as any, {
    type: 'user/message',
    data: { text: '压缩摘要回放', source: { kind: 'plugin', plugin: 'compact' } },
  } as any)
  assert(tickOf() === t1, "source.kind='plugin' / 缺失 / compact：均不产生刺激（不把快照当用户说话）")

  // 工具错误对象：{code,message} 必须透出 message，而不是 [object Object]
  ctx.emit('tools/result', { name: 'read_image' } as any, { error: { code: 'E_IO', message: '文件损坏无法读取' } } as any)
  const n1 = frameToNarrative(ctx.laap.report().frame!)
  assert(n1.includes('文件损坏无法读取') && !n1.includes('[object Object]'),
    '对象型工具错误 {code,message}：帧叙事透出真实信息（无 [object Object]）')

  // 字符串型错误保持原样
  ctx.emit('tools/result', { name: 'shell' } as any, { error: 'plain boom string', isError: true } as any)
  const n2 = frameToNarrative(ctx.laap.report().frame!)
  assert(n2.includes('plain boom string'), '字符串型工具错误：原样保留')

  // isError:true 但无 error 字段 → fallback
  ctx.emit('tools/result', { name: 'write_file' } as any, { isError: true } as any)
  const n3 = frameToNarrative(ctx.laap.report().frame!)
  assert(n3.includes('执行失败'), 'isError 无 error 对象：使用兜底文案')

  // laap_ 内省工具的结果不产生行动刺激（自我指涉防护仍在）
  const t2 = tickOf()
  ctx.emit('tools/result', { name: 'laap_recall' } as any, { error: { message: '不应出现' } } as any)
  assert(tickOf() === t2, 'laap_ 自有工具结果仍被跳过')

  await fiber.dispose()
  await sleep(300)

  console.log(`\n帧归档/容量/分层闸门/入流过滤测试全部通过：${passed} 条断言`)
} catch (err) {
  console.error(err)
  exitCode = 1
} finally {
  // 清理失败不得掩盖测试本体的断言错误
  for (const d of ALL_DBS) {
    try { rm(d) } catch { /* mmap 残留句柄时忽略，tmp 目录系统会回收 */ }
    try { rm(statePath(d)) } catch { /* ignore */ }
  }
  process.exit(exitCode)
}
