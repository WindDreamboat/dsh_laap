/**
 * laap-ui — 意识面板浏览器端（Client 半区，双面插件的 UI 半边）
 *
 * 在 sidebar 底部动作区常驻「意识之球」指示器；点击后经 createPortal 在
 * document.body 挂出悬浮层（绕开侧栏 overflow/transform 包含块），两种形态：
 *  1. 雷达悬浮窗（默认）：五维 Ψ 雷达 + 需求剥夺条 + 意识流时间线，
 *     可拖拽、位置/形态记忆（localStorage）。
 *  2. 意识桌宠：内核【状态同步】而非前端状态重算——SSE 推送心境分类
 *     mood.label / 认知模式 / 空闲秒数，PetFsm 只做一张优先级映射表
 *     （angry > 空闲休息 > study/explore > 低能量休息 > like/happy > idle）
 *     + 3s 时间滞回防抖；点击身体触发 0.9s 开心瞬时态。内置 momo 立绘
 *     形象（img/*.png，文件名即状态，运行时 canvas 绿幕抠除），另保留
 *     零资源 SVG 形象 blob。
 *
 * 形象扩展点：实现 PetAvatar 接口并登记进 PET_AVATARS（立绘包提供
 * 「状态 → 图片」表即可），桌宠工具栏循环切换。
 *
 * 架构边界：本文件是纯表现层，只消费内核下发的只读数据，不调用任何内核
 * 写接口、不持有情绪/能量阈值。数据通道：SSE 推送 `/api/laap/stream`
 * （帧定稿即推 + 3s 慢泵）为主，一元 RPC `/laap/snapshot` 轮询为兜底，
 * 两通道归一化到同一 store；快照契约类型来自内核共享源 snapshot-types。
 * 与 dsh 前端共享同一 React / react-dom 实例（不自行打包）。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import imgAnger from '../../../img/anger.png'
import imgHappy from '../../../img/happy.png'
import imgHello from '../../../img/hello.png'
import imgLike from '../../../img/like.png'
import imgRest from '../../../img/rest.png'
import imgStudy from '../../../img/study.png'
import { PetFsm, PET_STATE_LABEL, PET_IDLE_MS, type PetState } from './pet-fsm.ts'
import type { UiSnapshot } from '../../core/snapshot-types.ts'
import type { CognitiveMode } from '../../core/consciousness/types.ts'

export const name = 'laap-ui'
export const inject = ['slots']

/**
 * 快照类型直接来自内核共享契约（src/core/snapshot-types.ts，type-only
 * 导入在打包时擦除）；双端不再各自手写结构，字段漂移在编译期暴露。
 */
type Snap = UiSnapshot

const DIMENSIONS = ['stress', 'confidence', 'curiosity', 'relatedness', 'energy'] as const
const DIM_LABEL: Record<string, string> = { stress: '压力', confidence: '信心', curiosity: '好奇', relatedness: '连接', energy: '能量' }
const DIM_COLOR: Record<string, string> = {
  stress: '#e05d5d', confidence: '#4fae6d', curiosity: '#e0a13d', relatedness: '#5d8fe0', energy: '#9a6de0',
}
const MODE_COLOR: Record<CognitiveMode, string> = {
  intuitive: '#8a8f98', deliberate: '#4fae6d', analytic: '#5d8fe0', creative: '#9a6de0', reflective: '#e0a13d', exploratory: '#e0704f',
}
const MODE_LABEL: Record<CognitiveMode, string> = {
  intuitive: '直觉', deliberate: '思考', analytic: '分析', creative: '创造', reflective: '反思', exploratory: '探索',
}

type ViewKind = 'radar' | 'pet'
const VIEW_KEY = 'laap:view'
const AVATAR_KEY = 'laap:avatar'
const radarPosKey = 'laap:pos:radar'
const petPosKey = 'laap:pos:pet'

/**
 * 轻量 Connection RPC client（等价于已被移除导出的 createWebConnectionRpc）。
 * 协议：POST {channel}/{endpoint} → 四象限信封 {type:"client-request", rpcId, method, payload}
 * 响应：{type:"server-response", rpcId, result:{ok, value|error}}
 */
type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: object } }
interface SimpleRpc { call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult> }
const INTERNAL_BASE = 'http://dsh.internal'
function resolveBase(): string {
  const loc = globalThis.location as { origin?: string } | undefined
  return loc?.origin && loc.origin !== 'null' ? loc.origin : INTERNAL_BASE
}
function simpleUuid(): string {
  // 用 crypto.randomUUID()（现代浏览器 & Node 19+），fallback 到自造
  const g = globalThis as typeof globalThis & { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0, v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
const rpc: SimpleRpc = {
  async call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult> {
    const rpcId = simpleUuid()
    const url = `${resolveBase()}${channel}/${endpoint}`
    const res = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
    })
    if (!res.ok) throw new Error(`RPC transport failure: ${channel}/${endpoint} → HTTP ${res.status}`)
    const body = await res.json() as { type: string; rpcId?: string; result?: { ok: boolean; value?: unknown; error?: unknown } }
    if (body.type !== 'server-response' || body.rpcId !== rpcId || !body.result) {
      throw new Error(`RPC envelope mismatch for ${endpoint}`)
    }
    return body.result as RpcResult
  },
}

/** ── 共享快照 store：SSE 推送为主、一元 RPC 轮询为兜底，全插件共用 ──
 * 两条通道归一化到同一 snapCache（去重键 = 到达顺序，快照本身幂等）：
 *  - SSE（/api/laap/stream）：内核帧定稿/心跳即推 + 3s 慢泵，事件级实时；
 *  - 轮询（POST /laap/snapshot）：SSE 新鲜（6s 内有推送）时自动休眠，
 *    SSE 断线/不支持时无缝接管，EventSource 自带重连。 */
type SnapListener = (s: Snap | null) => void
let snapCache: Snap | null = null
const snapListeners = new Set<SnapListener>()
let snapTimer: ReturnType<typeof setInterval> | null = null
let snapStream: EventSource | null = null
let inflight = false
let lastPushAt = 0
/** SSE 推送新鲜期：该窗口内认为推送通道健康，轮询跳过 */
const PUSH_FRESH_MS = 6000

function applySnap(s: Snap): void {
  snapCache = s
  for (const l of snapListeners) l(snapCache)
}

async function pullSnap(): Promise<void> {
  if (inflight) return
  inflight = true
  try {
    const r = await rpc.call('/laap', 'snapshot', {})
    if (r.ok) applySnap(r.value as Snap)
  } catch { /* 宿主离线/未装 laap：维持旧值 */ } finally {
    inflight = false
  }
}

/** 兜底轮询：SSE 健康时静默，超过新鲜期无推送才实际发请求 */
async function fallbackPull(): Promise<void> {
  if (Date.now() - lastPushAt < PUSH_FRESH_MS) return
  await pullSnap()
}

function openSnapshotStream(): void {
  const g = globalThis as typeof globalThis & { EventSource?: typeof EventSource }
  const loc = globalThis.location as { origin?: string } | undefined
  if (typeof g.EventSource !== 'function' || !loc?.origin || loc.origin === 'null') return
  try {
    const es = new g.EventSource(`${loc.origin}/api/laap/stream`)
    snapStream = es
    es.onmessage = (ev: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string; value?: Snap }
        if (msg.type === 'snapshot' && msg.value) {
          lastPushAt = Date.now()
          applySnap(msg.value)
        }
      } catch { /* 单帧坏数据跳过，连接保持 */ }
    }
    // onerror 不处理：EventSource 自动重连；重连期间 lastPushAt 老化 → 轮询接管
  } catch { /* SSE 不可用：纯轮询模式 */ }
}

function subscribeSnap(l: SnapListener): () => void {
  snapListeners.add(l)
  if (snapListeners.size === 1) {
    lastPushAt = 0
    void pullSnap() // 立即基线（首帧不等 SSE 建连）
    openSnapshotStream()
    snapTimer = setInterval(() => void fallbackPull(), 3000)
  }
  l(snapCache)
  return () => {
    snapListeners.delete(l)
    if (snapListeners.size === 0) {
      if (snapTimer !== null) { clearInterval(snapTimer); snapTimer = null }
      snapStream?.close()
      snapStream = null
    }
  }
}
function useSnap(): Snap | null {
  const [snap, setSnap] = useState<Snap | null>(snapCache)
  useEffect(() => subscribeSnap(setSnap), [])
  return snap
}

/** ── 本地偏好（localStorage 可能被沙箱禁用，全部静默兜底）────────── */
function lsGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function lsSet(key: string, val: string): void {
  try { localStorage.setItem(key, val) } catch { /* 无隐私模式/配额时忽略 */ }
}

/** ── 一次性注入命名空间动画样式（esbuild CJS 包裹体不支持 CSS import）─ */
const STYLE_ID = 'laap-pet-style'
function injectStyle(): void {
  const doc = (globalThis as { document?: Document }).document
  if (!doc || doc.getElementById(STYLE_ID)) return
  const el = doc.createElement('style')
  el.id = STYLE_ID
  el.textContent = `
.laap-bob{animation:laap-bob 3.2s ease-in-out infinite}
@keyframes laap-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
.laap-hop{animation:laap-hop .36s ease}
@keyframes laap-hop{40%{transform:translateY(-13px)}}
.laap-halo{position:absolute;border-radius:50%;pointer-events:none}
.laap-halo-good{background:radial-gradient(circle,#4fae6d66 0%,#4fae6d00 72%);animation:laap-breathe 2.4s ease-in-out infinite}
.laap-halo-calm{background:radial-gradient(circle,#4f9dae40 0%,#4f9dae00 72%);animation:laap-breathe 3.8s ease-in-out infinite}
.laap-halo-bad{background:radial-gradient(circle,#e05d5d70 0%,#e05d5d00 72%);animation:laap-alert .9s ease-in-out infinite}
@keyframes laap-breathe{0%,100%{transform:scale(.9);opacity:.5}50%{transform:scale(1.12);opacity:1}}
@keyframes laap-alert{0%,100%{opacity:.25}50%{opacity:.95}}
.laap-rise{position:absolute;animation:laap-rise 1.2s ease-out forwards;font-weight:700;pointer-events:none;text-shadow:0 1px 3px #000}
@keyframes laap-rise{0%{transform:translateY(8px);opacity:0}15%{opacity:1}100%{transform:translateY(-32px);opacity:0}}
.laap-dots span{display:inline-block;animation:laap-dot 1.2s infinite}
.laap-dots span:nth-child(2){animation-delay:.2s}
.laap-dots span:nth-child(3){animation-delay:.4s}
@keyframes laap-dot{0%,100%{opacity:.2;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}
.laap-eye{transform-box:fill-box;transform-origin:center;animation:laap-blink 4.8s infinite}
@keyframes laap-blink{0%,93%,100%{transform:scaleY(1)}96%{transform:scaleY(.1)}}
.laap-pop{animation:laap-pop .18s ease-out}
@keyframes laap-pop{from{transform:scale(.94);opacity:0}to{transform:scale(1);opacity:1}}
.laap-toolbar{opacity:0;transition:opacity .15s}
.laap-petroot:hover .laap-toolbar,.laap-toolbar:focus-within{opacity:1}
@media (prefers-reduced-motion: reduce){
 .laap-bob,.laap-hop,.laap-halo-good,.laap-halo-calm,.laap-halo-bad,.laap-eye,.laap-pop{animation:none!important}
 .laap-rise{display:none}
 .laap-dots span{animation:none!important;opacity:.7}
}`
  doc.head.appendChild(el)
}
injectStyle()

/** ── 悬浮层拖拽（pointer 事件，位置钳制在视口内并记忆）──────────── */
interface XY { x: number; y: number }
function clampPos(p: XY, w: number, h: number): XY {
  const W = globalThis.innerWidth || 1280
  const H = globalThis.innerHeight || 720
  return {
    x: Math.min(Math.max(4, p.x), Math.max(4, W - w)),
    y: Math.min(Math.max(4, p.y), Math.max(4, H - h)),
  }
}
function loadPos(key: string, w: number, h: number, fallback: () => XY): XY {
  const raw = lsGet(key)
  if (raw) {
    const [x, y] = raw.split(',').map(Number)
    if (Number.isFinite(x) && Number.isFinite(y)) return clampPos({ x, y }, w, h)
  }
  return clampPos(fallback(), w, h)
}
/**
 * 悬浮层拖拽：原生 pointer 监听器挂在 handleRef 节点上（不走 React 合成
 * 事件——portal 到 body 后的事件委托链路更脆弱；原生监听对 trusted/合成
 * 事件一视同仁）。window 上监听 move/up，位置钳制视口并在松手时持久化。
 */
function useFixedDrag<T extends HTMLElement>(key: string, size: { w: number; h: number }, fallback: () => XY) {
  const [pos, setPos] = useState<XY>(() => loadPos(key, size.w, size.h, fallback))
  const posRef = useRef(pos)
  posRef.current = pos
  const handleRef = useRef<T>(null)
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean; x: number; y: number } | null>(null)
  // 松手时是否发生了真实位移——供 click 判定区分「点击」与「拖拽结束」
  // （不能直接读 drag.current：up 监听在 window 冒泡末端，先于 click 把它清空）
  const movedRef = useRef(false)

  useEffect(() => {
    const el = handleRef.current
    if (!el) return
    const down = (e: PointerEvent) => {
      movedRef.current = false
      drag.current = { sx: e.clientX, sy: e.clientY, ox: posRef.current.x, oy: posRef.current.y, moved: false, x: posRef.current.x, y: posRef.current.y }
    }
    const move = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      if (Math.abs(e.clientX - d.sx) > 3 || Math.abs(e.clientY - d.sy) > 3) d.moved = true
      const np = clampPos({ x: e.clientX - d.sx + d.ox, y: e.clientY - d.sy + d.oy }, size.w, size.h)
      d.x = np.x; d.y = np.y
      setPos(np)
    }
    const up = () => {
      const d = drag.current
      if (d) {
        if (d.moved) lsSet(key, `${d.x},${d.y}`)
        movedRef.current = d.moved
        drag.current = null
      }
    }
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [key, size.w, size.h])

  return { pos, handleRef, movedRef }
}

/** ── 五维雷达图（SVG）─────────────────────────────────────────── */
function Radar({ s, eventTick }: { s: Snap['state']; eventTick: number }) {
  const cx = 60, cy = 62, R = 36
  const pt = (i: number, r: number) => {
    const a = (Math.PI * 2 * i) / 5 - Math.PI / 2
    return [cx + Math.cos(a) * R * r, cy + Math.sin(a) * R * r] as const
  }
  const ring = (r: number) => DIMENSIONS.map((_, i) => pt(i, r).join(',')).join(' ')
  const shape = DIMENSIONS.map((d, i) => pt(i, Math.max(0.08, s[d]))).map((p) => p.join(',')).join(' ')
  return (
    <svg width="120" height="120" viewBox="0 0 120 124" role="img" aria-label="意识状态雷达图">
      {[1, 2 / 3, 1 / 3].map((r) => (
        <polygon key={r} points={ring(r)} fill="none" stroke="#8883" strokeWidth="1" />
      ))}
      {DIMENSIONS.map((d, i) => {
        // 双字标签放最外环外侧（1.25R），不与数据多边形/网格重叠
        const [x, y] = pt(i, 1.25)
        return <text key={d} x={x} y={y + 4} fontSize="10" textAnchor="middle" fill={DIM_COLOR[d]}>{DIM_LABEL[d]}</text>
      })}
      <polygon points={shape} fill="#4f9dae33" stroke="#4f9dae" strokeWidth="1.5" />
      {DIMENSIONS.map((d, i) => {
        const [x, y] = pt(i, Math.max(0.08, s[d]))
        return <circle key={d} cx={x} cy={y} r="2.6" fill={DIM_COLOR[d]} />
      })}
      <text x={cx} y={118} fontSize="10" textAnchor="middle" fill="#999">经历 {eventTick} 帧</text>
    </svg>
  )
}

/** ── 意识流时间线：模式色带 + 显著性柱 ─────────────────────────── */
function Timeline({ frames }: { frames: Snap['frameLog'] }) {
  const recent = frames.slice(-32)
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, color: '#999', marginBottom: 4 }}>意识流（近 {recent.length} 帧）</div>
      <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 44 }}>
        {recent.map((f) => (
          <div key={f.tick} title={`帧 ${f.tick} · ${MODE_LABEL[f.mode] ?? f.mode} · ${f.qualia.join('·')}`}
            style={{ flex: 1, minWidth: 3, height: `${Math.max(8, f.salience * 100)}%`, background: MODE_COLOR[f.mode] ?? '#888', borderRadius: 2, opacity: 0.85 }} />
        ))}
        {recent.length === 0 && <div style={{ fontSize: 11, color: '#777' }}>（尚无广播帧）</div>}
      </div>
      {recent.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 4, marginTop: 6, fontSize: 10 }}>
          {(Object.entries(MODE_COLOR) as [CognitiveMode, string][]).map(([m, c]) => (
            <span key={m} style={{ color: '#aaa' }}><span style={{ color: c }}>■</span>{MODE_LABEL[m]}</span>
          ))}
        </div>
      )}
    </div>
  )
}

/** ── 记忆区：程序性技能（学会了什么）+ 工作记忆（此刻想着什么）──────
 * 语义/情景自传走 laap_recall 工具供模型内省；面板只投影程序性与工作记忆，
 * 让用户直观看见「它学会了什么」。数据全部来自内核快照，表现层不重算。 */
function Memory({ snap }: { snap: Snap }) {
  const skills = snap.skillNames ?? []
  const working = snap.working.slice(-4)
  if (skills.length === 0 && working.length === 0) return null
  return (
    <div style={{ marginTop: 8, borderTop: '1px solid #ffffff14', paddingTop: 6 }}>
      <div style={{ fontSize: 11, color: '#999', marginBottom: 4 }}>
        记忆{skills.length > 0 ? ` · ${skills.length} 项技能` : ''}
      </div>
      {skills.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 5 }}>
          {skills.map((n) => (
            <span key={n} title={`已沉淀技能：${n}`}
              style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: '#7c5cff22', color: '#b9a6ff', border: '1px solid #7c5cff44' }}>
              {n}
            </span>
          ))}
        </div>
      )}
      {working.length > 0 && (
        <div style={{ fontSize: 10, color: '#9a9a9a', lineHeight: 1.6 }}>
          {working.map((w, i) => (
            <div key={i} title={w} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>· {w}</div>
          ))}
        </div>
      )}
    </div>
  )
}

/** ── 雷达悬浮窗（默认形态）─────────────────────────────────────── */
function RadarWindow({ onPet, onClose }: { onPet: () => void; onClose: () => void }) {
  const snap = useSnap()
  const { pos, handleRef } = useFixedDrag<HTMLDivElement>(radarPosKey, { w: 300, h: 380 }, () => ({ x: globalThis.innerWidth - 316, y: 96 }))
  // 标题栏心境指示：用内核 EMA 平滑后的 mood.level（瞬时脉冲见时间线 qualia）
  const v = snap?.mood.level ?? 0
  return createPortal(
    <div className="laap-pop" style={{ ...panelStyle, position: 'fixed', left: pos.x, top: pos.y, zIndex: 9999, width: 300 }}>
      <div ref={handleRef} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'move', marginBottom: 8 }}>
        <b>意识状态</b>
        {snap && (
          <span style={{ fontSize: 11, color: v >= 0 ? '#4fae6d' : '#e05d5d' }}>
            {v >= 0 ? '↑' : '↓'} {v.toFixed(2)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button title="雷达视图（当前）" style={chip(true)}>📊</button>
        <button onClick={onPet} title="切换为意识桌宠" style={chip(false)}>🐾</button>
        <button onClick={onClose} title="收起" style={btn}>✕</button>
      </div>
      {!snap ? (
        <div style={{ color: '#999', padding: '18px 0', textAlign: 'center' }}>等待宿主意识内核应答…</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Radar s={snap.state} eventTick={snap.eventTick} />
            <div style={{ flex: 1, fontSize: 11, color: '#bbb' }}>
              {DIMENSIONS.map((d) => (
                <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                  <span style={{ width: 26, color: DIM_COLOR[d] }}>{DIM_LABEL[d]}</span>
                  <div style={{ flex: 1, height: 5, background: '#8883', borderRadius: 3 }}>
                    <div style={{ width: `${snap.state[d] * 100}%`, height: '100%', background: DIM_COLOR[d], borderRadius: 3 }} />
                  </div>
                  <span style={{ width: 26, textAlign: 'right' }}>{snap.state[d].toFixed(2)}</span>
                </div>
              ))}
              <div style={{ marginTop: 6 }}>信心校准 <b style={{ color: '#4fae6d' }}>{snap.monitor.calibrated.toFixed(2)}</b>
                {' · '}技能 <b>{snap.skills}</b></div>
              <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>
                {snap.restoredFrom ? `意识延续自 ${new Date(snap.restoredFrom.savedAt).toLocaleString()}` : '新生意识'}
              </div>
            </div>
          </div>
          <Timeline frames={snap.frameLog} />
          <Memory snap={snap} />
        </>
      )}
    </div>,
    document.body,
  )
}

/** ── 桌宠有限状态机（实现见 pet-fsm.ts，纯逻辑可独立单测）────────── */

/** ── 绿幕色键（运行时 canvas 抠图）──────────────────────────────
 * 立绘 PNG 为统一绿底，直接渲染会是绿方块：首次使用时把绿色主导像素
 * alpha 置 0（强绿全透、边缘羽化），并对保留像素做去绿溢色（减轻发丝
 * 边缘的绿镶边），输出 data URL 缓存。输入本身是 data URL，无跨域污染。 */
const chromaCache = new Map<string, Promise<string>>()
function chromaKey(src: string): Promise<string> {
  const cached = chromaCache.get(src)
  if (cached) return cached
  const p = new Promise<string>((resolve) => {
    const doc = (globalThis as { document?: Document }).document
    if (typeof Image === 'undefined' || !doc) { resolve(src); return }
    const img = new Image()
    img.onload = () => {
      try {
        const c = doc.createElement('canvas')
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        const g = c.getContext('2d')
        if (!g) { resolve(src); return }
        g.drawImage(img, 0, 0)
        const frame = g.getImageData(0, 0, c.width, c.height)
        const d = frame.data
        // 采样四角估绿幕底色（立绘为统一绿底，四角不被人物遮挡）
        let bgR = 0, bgG = 0, bgB = 0
        for (const [px, py] of [[2, 2], [c.width - 3, 2], [2, c.height - 3], [c.width - 3, c.height - 3]] as const) {
          const k = (py * c.width + px) * 4
          bgR += d[k]; bgG += d[k + 1]; bgB += d[k + 2]
        }
        bgR /= 4; bgG /= 4; bgB /= 4
        const KEY_HI = 52 // 绿色超出量高于此值：绿幕核心，全透
        const KEY_LO = 18 // 羽化带下限
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], gg = d[i + 1], b = d[i + 2]
          const ex = gg - Math.max(r, b) // 绿色超出量
          if (ex > KEY_HI) {
            d[i + 3] = 0
          } else if (ex > KEY_LO) {
            // 羽化带：观测色 = 前景*a + 绿底*(1-a)。先按绿色超出量估覆盖率，
            // 再反预乘还原前景色，彻底去掉边缘半透明像素里的绿底贡献（绿镶边根因）
            const a0 = d[i + 3] / 255
            const a = Math.max(0, Math.min(1, ((KEY_HI - ex) / (KEY_HI - KEY_LO)) * a0))
            d[i + 3] = Math.round(a * 255)
            if (a > 0.03) {
              d[i]     = Math.max(0, Math.min(255, Math.round((r - bgR * (1 - a)) / a)))
              d[i + 1] = Math.max(0, Math.min(255, Math.round((gg - bgG * (1 - a)) / a)))
              d[i + 2] = Math.max(0, Math.min(255, Math.round((b - bgB * (1 - a)) / a)))
            }
          } else if (ex > 6) {
            // 近不透区域的轻度绿溢：绿通道压回红蓝均值
            d[i + 1] = Math.round(Math.min(gg, (r + b) / 2))
          }
        }
        g.putImageData(frame, 0, 0)
        resolve(c.toDataURL('image/png'))
      } catch {
        resolve(src) // canvas 不可用时退回原图（带绿底），不阻塞渲染
      }
    }
    img.onerror = () => resolve(src)
    img.src = src
  })
  chromaCache.set(src, p)
  return p
}

/** ── 桌宠形象扩展点 ─────────────────────────────────────────────
 * 新增立绘形象：提供「PetState → 图片 URL」表并登记 PET_AVATARS 即可
 * （文件名即状态）；FSM、光晕、+N 浮字、拖拽等由外壳统一提供。
 * 桌宠工具栏会按注册表顺序循环切换；id 持久化在 localStorage。 */
interface PetVisualState {
  /** 内核平滑心境水平（SVG 类形象做细节差异用） */
  moodLevel: number
  stress: number
  energy: number
  tick: number
  mode: CognitiveMode
}
interface PetAvatarProps {
  /** FSM 裁决后的有效状态（已包含点击瞬时态） */
  state: PetState
  /** 原始快照数值（SVG 类形象做细节差异用） */
  vs: PetVisualState
  /** 视线单位向量 [-1,1]（explore 状态下跟随鼠标，其余为 0） */
  gaze: XY
}
interface PetAvatar {
  id: string
  label: string
  Body: (p: PetAvatarProps) => ReactElement
  /** 是否在专注态显示思考气泡装饰（立绘自身已表意，默认 false） */
  thoughtBubble?: boolean
}

/** 立绘形象 momo：img/*.png，文件名对应 FSM 状态（explore 复用 hello） */
const MOMO_IMG: Record<PetState, string> = {
  idle: imgHello,
  happy: imgHappy,
  like: imgLike,
  angry: imgAnger,
  study: imgStudy,
  explore: imgHello,
  rest: imgRest,
}
function MomoBody({ state, gaze }: PetAvatarProps): ReactElement {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void chromaKey(MOMO_IMG[state]).then((u) => { if (alive) setUrl(u) })
    // 首次挂载即后台预热其余状态，之后切态零等待
    for (const s of Object.keys(MOMO_IMG) as PetState[]) void chromaKey(MOMO_IMG[s])
    return () => { alive = false }
  }, [state])
  const tilt = state === 'explore'
    ? `rotate(${gaze.x * 7}deg) translate(${gaze.x * 3}px, ${gaze.y * 3}px)`
    : undefined
  return (
    <div style={{ width: 124, height: 150, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      {url
        ? (
          <img
            key={url}
            src={url}
            alt=""
            draggable={false}
            className="laap-pop"
            style={{
              maxWidth: 124, maxHeight: 150, transform: tilt, transition: 'transform .12s ease-out',
              filter: 'drop-shadow(0 4px 6px rgba(0,0,0,.5))', pointerEvents: 'none',
            }}
          />
        )
        : <BubbleWaiting />}
    </div>
  )
}

/** 零资源形象：意识团（纯 SVG；情绪表情 + 可转动眼球） */
function BlobBody({ state, gaze }: PetAvatarProps): ReactElement {
  const mood = state === 'angry' ? 'tired' : state === 'happy' || state === 'like' ? 'happy' : 'calm'
  const tint = mood === 'happy' ? '#8fe0b4' : mood === 'tired' ? '#aab4bd' : '#7fc9d6'
  const dark = mood === 'tired' ? '#6c7681' : '#3d8c9a'
  // explore 状态强制睁眼（视线要可见）；生气时眼睛画成下垂弧线
  const openEyes = mood !== 'tired' || state === 'explore'
  const mouth = mood === 'happy'
    ? 'M40,62 Q48,71 56,62'
    : mood === 'tired' ? 'M43,66 Q48,61 53,66' : 'M43,64 L53,64'
  return (
    <svg width="92" height="92" viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <radialGradient id="laap-blob-grad" cx="38%" cy="30%" r="78%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="38%" stopColor={tint} />
          <stop offset="100%" stopColor={dark} />
        </radialGradient>
      </defs>
      <ellipse cx="50" cy="54" rx="34" ry="32" fill="url(#laap-blob-grad)" stroke="#ffffff22" />
      {mood === 'happy' && (
        <>
          <circle cx="29" cy="58" r="4.5" fill="#ef8fa0" opacity="0.55" />
          <circle cx="71" cy="58" r="4.5" fill="#ef8fa0" opacity="0.55" />
        </>
      )}
      {openEyes ? (
        <>
          <g className="laap-eye">
            <ellipse cx="36" cy="46" rx="7.5" ry="8.5" fill="#fff" />
            <circle cx={36 + gaze.x * 3} cy={46 + gaze.y * 2.4} r="3.4" fill="#2a2f37" />
          </g>
          <g className="laap-eye">
            <ellipse cx="62" cy="46" rx="7.5" ry="8.5" fill="#fff" />
            <circle cx={62 + gaze.x * 3} cy={46 + gaze.y * 2.4} r="3.4" fill="#2a2f37" />
          </g>
        </>
      ) : (
        <>
          <path className="laap-eye" d="M29,48 Q36,42.5 43,48" fill="none" stroke="#2a2f37" strokeWidth="2.2" strokeLinecap="round" />
          <path className="laap-eye" d="M55,48 Q62,42.5 69,48" fill="none" stroke="#2a2f37" strokeWidth="2.2" strokeLinecap="round" />
          <text x="72" y="34" fontSize="11" fill="#dfe6ea" opacity="0.8">z</text>
        </>
      )}
      <path d={mouth} fill="none" stroke="#2a2f37" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

const PET_AVATARS: Record<string, PetAvatar> = {
  momo: { id: 'momo', label: '茉茉', Body: MomoBody },
  blob: { id: 'blob', label: '意识团', Body: BlobBody, thoughtBubble: true },
}
const DEFAULT_AVATAR = 'momo'

function deriveVS(snap: Snap): PetVisualState {
  return {
    moodLevel: snap.mood.level,
    stress: snap.state.stress,
    energy: snap.state.energy,
    tick: snap.state.tick,
    mode: snap.frameLog.at(-1)?.mode ?? 'intuitive',
  }
}

/** ── 意识桌宠悬浮层 ───────────────────────────────────────────── */
function PetWindow({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const snap = useSnap()
  const { pos, handleRef, movedRef } = useFixedDrag<HTMLDivElement>(petPosKey, { w: 136, h: 196 }, () => ({ x: globalThis.innerWidth - 152, y: globalThis.innerHeight - 276 }))
  const bodyRef = useRef<HTMLDivElement>(null)
  const [gaze, setGaze] = useState<XY>({ x: 0, y: 0 })
  const [pops, setPops] = useState<{ id: number; n: number }[]>([])
  const [hop, setHop] = useState(0)
  const popId = useRef(0)
  const lastTick = useRef<number | null>(null)
  const fsmRef = useRef<PetFsm | null>(null)
  if (!fsmRef.current) fsmRef.current = new PetFsm()
  const [base, setBase] = useState<PetState>('idle')
  // 点击瞬时态（happy 0.9s）：与基础态分层，不顶掉 FSM 状态
  const [reactUntil, setReactUntil] = useState(0)
  const reactTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [avatarId, setAvatarId] = useState(() => {
    const saved = lsGet(AVATAR_KEY)
    return saved && PET_AVATARS[saved] ? saved : DEFAULT_AVATAR
  })

  const vs = snap ? deriveVS(snap) : null

  // 快照 → FSM 映射表（SSE 事件驱动推送 + 3s 慢泵；前端只映射不重算）
  useEffect(() => {
    if (!snap || !fsmRef.current) return
    setBase(fsmRef.current.update({
      mood: snap.mood.label,
      mode: snap.frameLog.at(-1)?.mode ?? 'intuitive',
      idle: snap.idleSeconds * 1000 > PET_IDLE_MS,
      now: Date.now(),
    }))
  }, [snap])

  // tick 增长 → 头顶 +N（一个轮询周期内的多跳合并显示）
  useEffect(() => {
    if (!snap) return
    const t = snap.state.tick
    if (lastTick.current === null) { lastTick.current = t; return }
    const delta = t - lastTick.current
    lastTick.current = t
    if (delta > 0) {
      const id = ++popId.current
      setPops((p) => [...p.slice(-5), { id, n: delta }])
      const timer = setTimeout(() => setPops((p) => p.filter((x) => x.id !== id)), 1200)
      return () => clearTimeout(timer)
    }
  }, [snap])

  const state: PetState = reactUntil > Date.now() ? 'happy' : base

  // explore：视线跟随鼠标（立绘为整体轻微倾斜，SVG 形象为眼球位移）
  useEffect(() => {
    if (base !== 'explore') {
      setGaze({ x: 0, y: 0 })
      return
    }
    const onMove = (e: MouseEvent) => {
      const el = bodyRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const dx = e.clientX - (r.left + r.width / 2)
      const dy = e.clientY - (r.top + r.height / 2)
      const len = Math.hypot(dx, dy) || 1
      setGaze({ x: Math.max(-1, Math.min(1, dx / len)), y: Math.max(-1, Math.min(1, dy / len)) })
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [base])

  const cycleAvatar = () => {
    const ids = Object.keys(PET_AVATARS)
    const next = ids[(ids.indexOf(avatarId) + 1) % ids.length]
    setAvatarId(next)
    lsSet(AVATAR_KEY, next)
  }
  const avatar = PET_AVATARS[avatarId] ?? PET_AVATARS[DEFAULT_AVATAR]
  const haloClass = state === 'angry' ? 'laap-halo-bad' : state === 'happy' || state === 'like' ? 'laap-halo-good' : 'laap-halo-calm'
  const aria = vs
    ? `意识桌宠：${PET_STATE_LABEL[state]}（tick ${vs.tick}）`
    : '意识桌宠：等待内核应答'

  const onPetClick = () => {
    if (movedRef.current) return
    const now = Date.now()
    fsmRef.current?.poke(now)
    setHop((h) => h + 1)
    setReactUntil(now + 900)
    if (reactTimer.current) clearTimeout(reactTimer.current)
    reactTimer.current = setTimeout(() => setReactUntil(0), 900)
  }

  return createPortal(
    <div
      ref={handleRef}
      className="laap-petroot"
      role="img"
      aria-label={aria}
      onClick={onPetClick}
      style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 9999, width: 136, cursor: 'grab', userSelect: 'none', touchAction: 'none' }}
    >
      {/* tick +N 浮字 */}
      {pops.map((p) => (
        <span key={p.id} className="laap-rise"
          style={{ left: '50%', top: -4, marginLeft: -16, fontSize: 13, color: '#7fe0c0' }}>+{p.n}</span>
      ))}
      {/* 情绪光晕 */}
      <div className={`laap-halo ${haloClass}`} style={{ left: 4, top: 6, width: 128, height: 128 }} />
      {/* 专注思考气泡（仅声明支持的形象，如 blob） */}
      {avatar.thoughtBubble && base === 'study' && (
        <div style={{
          position: 'absolute', left: 100, top: 18, background: '#23272e', border: '1px solid #ffffff1a',
          borderRadius: 10, padding: '3px 7px', fontSize: 13, lineHeight: 1, color: '#cfd6dd',
          letterSpacing: 2, whiteSpace: 'nowrap', pointerEvents: 'none',
        }} className="laap-dots">
          <span>·</span><span>·</span><span>·</span>
        </div>
      )}
      {/* 身体（外层 hop 点击反馈，内层 bob 呼吸浮动） */}
      <div ref={bodyRef} key={hop} className={hop > 0 ? 'laap-hop' : undefined}
        style={{ position: 'relative', width: 124, height: 150, margin: '2px auto 0', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
        <div className="laap-bob" style={{ display: 'flex', alignItems: 'flex-end' }}>
          {snap && vs ? <avatar.Body state={state} vs={vs} gaze={gaze} /> : <BubbleWaiting />}
        </div>
      </div>
      <div style={{
        textAlign: 'center', fontSize: 11, fontWeight: 600, color: '#e6ebf0',
        textShadow: '0 1px 2px rgba(0,0,0,.95), 0 0 1px rgba(0,0,0,.9)', pointerEvents: 'none',
      }}
      >
        {vs ? PET_STATE_LABEL[state] : '连接中…'}
      </div>
      {/* hover 工具栏：回雷达 / 切形象 / 关闭（按钮 mousedown 冒泡仅置位拖拽，
          未移动即不视为拖拽，不影响 click） */}
      <div className="laap-toolbar" style={{ position: 'absolute', right: -12, top: 40, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button onClick={onBack} title="回到雷达视图" style={miniBtn}>📊</button>
        <button onClick={cycleAvatar} title={`切换形象（当前：${avatar.label}）`} style={miniBtn}>🔄</button>
        <button onClick={onClose} title="收起桌宠" style={miniBtn}>✕</button>
      </div>
    </div>,
    document.body,
  )
}

function BubbleWaiting(): ReactElement {
  return (
    <svg width="92" height="92" viewBox="0 0 100 100" aria-hidden="true">
      <ellipse cx="50" cy="54" rx="34" ry="32" fill="#3a4149" stroke="#ffffff22" />
      <circle cx="38" cy="48" r="3" fill="#9aa2ab" /><circle cx="60" cy="48" r="3" fill="#9aa2ab" />
    </svg>
  )
}

/** ── 悬浮层宿主（形态切换 + 偏好记忆）──────────────────────────── */
function Overlay({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<ViewKind>(() => (lsGet(VIEW_KEY) === 'pet' ? 'pet' : 'radar'))
  const go = (v: ViewKind) => { setView(v); lsSet(VIEW_KEY, v) }
  return view === 'radar'
    ? <RadarWindow onPet={() => go('pet')} onClose={onClose} />
    : <PetWindow onBack={() => go('radar')} onClose={onClose} />
}

/** ── 侧栏指示器（常驻小球：能量环 + 压力闪烁）──────────────────── */
function LaapOrb() {
  const [open, setOpen] = useState(false)
  const snap = useSnap()
  const stress = snap?.state.stress ?? 0
  const energy = snap?.state.energy ?? 0.5
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="意识状态面板"
        aria-expanded={open}
        style={{
          width: 22, height: 22, borderRadius: '50%', cursor: 'pointer', border: 'none',
          background: `conic-gradient(#4f9dae ${energy * 360}deg, #6663 0deg)`,
          boxShadow: stress > 0.55 ? `0 0 ${4 + stress * 8}px #e05d5daa` : 'none',
          opacity: 0.9,
        }}
      />
      {open && <Overlay onClose={() => setOpen(false)} />}
    </div>
  )
}

const panelStyle: CSSProperties = {
  background: '#1e2126f2', color: '#ddd', borderRadius: 10,
  border: '1px solid #ffffff1a', padding: 10, boxShadow: '0 8px 32px #000a', fontSize: 12,
}
const btn: CSSProperties = { background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 12, padding: '2px 4px' }
const miniBtn: CSSProperties = { ...btn, background: '#23272eee', border: '1px solid #ffffff1a', borderRadius: 6, fontSize: 11, padding: '2px 5px' }
function chip(active: boolean): CSSProperties {
  return {
    ...btn, padding: '2px 6px', borderRadius: 6,
    background: active ? '#4f9dae33' : 'none',
    color: active ? '#9fe0ea' : '#aaa',
    border: active ? '1px solid #4f9dae55' : '1px solid transparent',
  }
}

/**
 * 客户端 Context 最小类型面：`slots` 服务座位由 dsh 客户端模块系统按
 * package.json 的 dsh.client.inject 在运行时注入；框架侧的 Context 类型
 * 增强位于 dsh-client-ui-renderer 等包（本插件不引这些 devDeps），这里只
 * 声明实际使用的 inject / register 形状，保持零额外类型依赖。
 */
interface SlotRegistration { name: string; id?: string; order?: number }
type ClientContext = Context & {
  slots: {
    inject(key: string, run: () => (() => void) | void): void
    register(options: SlotRegistration, component: () => ReactElement | null): () => void
  }
}

export function apply(ctx: ClientContext) {
  // 挂进侧栏底部动作区（list 槽位，注册需带 id）
  ctx.slots.inject('sidebar.footer.action', () => {
    const dispose = ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'laap-consciousness', order: 20 },
      LaapOrb,
    )
    return () => dispose()
  })
}
