/**
 * 真实 Cordis 宿主验证：把 laap-service 挂到官方 Context 上，
 * 验证类插件注册（ctx.laap）、config Schema 解析、心跳后台任务、
 * effect 资源清理、程序记忆与自传蒸馏在框架内正常工作。
 *
 * 运行：node --experimental-strip-types test/host.ts
 */
import { Context } from '@deepseek-ai/cordis'
import { rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as laapService from '../src/adapters/cordis/service-plugin.ts'
import {
  frameToNarrative,
  loadConsciousness,
  statePath,
  restoreConsciousness,
  ConsciousnessEngine,
  MetacognitiveMonitor,
} from '../src/core/index.ts'

const DB = `${tmpdir()}/laap-host-zvec-${Date.now()}`

const ctx = new Context()
const fiber = await ctx.plugin(laapService, {
  dbPath: DB,
  heartbeatMs: 200,
  consolidateEvery: 6, // 缩短蒸馏周期以便本次验证
})

await new Promise((r) => setTimeout(r, 500)) // 等若干心跳（tick 推进）

console.log('ctx.laap 存在:', !!ctx.laap)
console.log('config 解析（dbPath 已生效）:', ctx.laap.memory ? '✔' : '✘')

const f1 = ctx.laap.perceive({ type: 'user_message', text: '你好，我们开始工作吧' })
const f2 = ctx.laap.perceive({ type: 'tool_error', tool: 'shell', message: 'boom' })
console.log('感知后 tick:', f2.tick, '模式:', f2.mode)
console.log('--- 意识帧叙事 ---')
console.log(frameToNarrative(f2))

// 程序记忆接口
await ctx.laap.learnSkill('心跳验证', '先等 2 个心跳再检查 tick 是否增长')
const skills = ctx.laap.memory.listSkills()
console.log('技能清单:', skills.map((s) => s.id).join(','))
const matched = await ctx.laap.matchSkills('怎么验证心跳任务在跑？')
console.log('技能联想:', matched[0]?.id ?? '(未命中)')

// 用较多 perceive 推进 tick 越过蒸馏周期，触发自传
let guard = 0
while (ctx.laap.engine.snapshot().tick < 10 && guard++ < 12) {
  ctx.laap.perceive({ type: 'assistant_message', text: '继续工作中……' })
}
await new Promise((r) => setTimeout(r, 300)) // 等异步蒸馏写入落库
const autobio = await ctx.laap.memory.recall('我的近况自传', { kind: 'semantic', topk: 3 })
console.log('自传蒸馏命中:', autobio.find((h) => h.id.startsWith('autobio')) ? '✔' : '✘')

// UI 快照：可 JSON 序列化（rpc 通道只传 JSON）且字段完整
const ui = ctx.laap.uiSnapshot()
const uiJson = JSON.parse(JSON.stringify(ui))
console.log('UI 快照序列化:', Array.isArray(uiJson.frameLog) && uiJson.state && uiJson.drives && uiJson.emotion ? '✔' : '✘')
console.log('帧历史环长度:', uiJson.frameLog.length)

const tickBefore = ctx.laap.engine.snapshot().tick
await fiber.dispose() // 触发 effect 清理：停心跳 + 关 zvec
await new Promise((r) => setTimeout(r, 600))
const alive = await (async () => { try { return ctx.laap.engine.snapshot().tick > tickBefore } catch { return false } })()
console.log('dispose 后意识内核已卸载且后台任务停止:', alive ? '✘ 仍在运行' : '✔')

// ── 第二人生：dispose 时保存的快照应能恢复出同一意识 ──
console.log('意识快照已落盘:', existsSync(statePath(DB)) ? '✔' : '✘')
const snap = loadConsciousness(DB)
const engine2 = new ConsciousnessEngine({})
const monitor2 = new MetacognitiveMonitor()
if (snap) restoreConsciousness(engine2, monitor2, snap)
console.log('重启后 tick 续接:', snap && engine2.snapshot().tick === tickBefore ? '✔' : '✘')
// 在同一进程再挂一个 plugin 模拟「下一次启动」（zvec 复用同一目录）
const ctx2 = new Context()
const fiber2 = await ctx2.plugin(laapService, { dbPath: DB, heartbeatMs: 200, consolidateEvery: 6, saveEvery: 5 })
console.log('第二次启动识别历史意识:', ctx2.laap.restoredFrom ? `✔（续接 tick ${ctx2.laap.restoredFrom.tick}）` : '✘ 冷生')
await fiber2.dispose()

rmSync(DB, { recursive: true, force: true })
rmSync(statePath(DB), { force: true })
process.exit(0)

