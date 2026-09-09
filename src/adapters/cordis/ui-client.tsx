/**
 * laap-ui — 意识面板浏览器端（Client 半区，双面插件的 UI 半边）
 *
 * 在 sidebar 底部动作区常驻「意识之球」指示器；点击后经 createPortal 在
 * document.body 挂出悬浮层（绕开侧栏 overflow/transform 包含块），两种形态：
 *  1. 雷达悬浮窗（默认）：五维 Ψ 雷达 + 需求剥夺条 + 意识流时间线，
 *     可拖拽、位置/形态记忆（localStorage）。
 *  2. 意识桌宠：内核 uiSnapshot 纯 JSON 的视觉投影——
 *     · valence > 0：开心表情 + 绿色呼吸光晕；valence < 0：疲惫表情 + 红色闪烁
 *     · deliberate 模式：思考气泡动画；exploratory 模式：眼球跟随鼠标
 *     · tick 增长：头顶冒 +N 浮字（3s 轮询周期内可能合并为一次 +N）
 *
 * 形象扩展点：实现 PetAvatar 接口并登记进 PET_AVATARS 即可（例如立绘包：
 * Body 内用 <img> 分层、按 PetVisualState 切表情层），桌宠工具栏循环切换。
 *
 * 架构边界：本文件是纯表现层，只消费 RPC `/laap/snapshot` 的只读 JSON，
 * 不调用任何内核写接口；与 laap_* 工具一样属于宿主侧「投影」。
 * 数据通道为 Connection RPC 独立频道（/api 是网关保留频道，第三方不得
 * intercept）；与 dsh 前端共享同一 React / react-dom 实例（不自行打包）。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'laap-ui'
export const inject = ['slots']

/** ── 数据类型（与 LaapService.uiSnapshot 对齐的最小投影）─────────── */
interface Snap {
  state: { stress: number; confidence: number; curiosity: number; relatedness: number; energy: number; tick: number }
  drives: Record<string, number>
  emotion: { valence: number }
  monitor: { calibrated: number; failureRate: number }
  skills: number
  restoredFrom: { savedAt: number; tick: number } | null
  frameLog: { tick: number; mode: string; qualia: string[]; salience: number }[]
}

const DIMENSIONS = ['stress', 'confidence', 'curiosity', 'relatedness', 'energy'] as const
const DIM_LABEL: Record<string, string> = { stress: '压', confidence: '信', curiosity: '奇', relatedness: '连', energy: '能' }
const DIM_COLOR: Record<string, string> = {
  stress: '#e05d5d', confidence: '#4fae6d', curiosity: '#e0a13d', relatedness: '#5d8fe0', energy: '#9a6de0',
}
const MODE_COLOR: Record<string, string> = {
  intuitive: '#8a8f98', deliberate: '#4fae6d', analytic: '#5d8fe0', creative: '#9a6de0', reflective: '#e0a13d', exploratory: '#e0704f',
}
const MODE_LABEL: Record<string, string> = {
  intuitive: '直觉', deliberate: '思考', analytic: '分析', creative: '创造', reflective: '反思', exploratory: '探索',
}
const MOOD_LABEL: Record<Mood, string> = { happy: '开心', tired: '疲惫', calm: '平静' }

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

/** ── 共享快照 store：全插件单路 3s 轮询，指示器/雷达/桌宠共用 ─────── */
type SnapListener = (s: Snap | null) => void
let snapCache: Snap | null = null
const snapListeners = new Set<SnapListener>()
let snapTimer: ReturnType<typeof setInterval> | null = null
let inflight = false
async function pullSnap() {
  if (inflight) return
  inflight = true
  try {
    const r = await rpc.call('/laap', 'snapshot', {})
    if (r.ok) {
      snapCache = r.value as Snap
      for (const l of snapListeners) l(snapCache)
    }
  } catch { /* 宿主离线/未装 laap：维持旧值 */ } finally {
    inflight = false
  }
}
function subscribeSnap(l: SnapListener): () => void {
  snapListeners.add(l)
  if (snapListeners.size === 1) {
    void pullSnap()
    snapTimer = setInterval(pullSnap, 3000)
  }
  l(snapCache)
  return () => {
    snapListeners.delete(l)
    if (snapListeners.size === 0 && snapTimer !== null) {
      clearInterval(snapTimer)
      snapTimer = null
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
function Radar({ s }: { s: Snap['state'] }) {
  const cx = 60, cy = 62, R = 44
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
        const [x, y] = pt(i, 0.62)
        return <text key={d} x={x} y={y + 4} fontSize="11" textAnchor="middle" fill={DIM_COLOR[d]}>{DIM_LABEL[d]}</text>
      })}
      <polygon points={shape} fill="#4f9dae33" stroke="#4f9dae" strokeWidth="1.5" />
      {DIMENSIONS.map((d, i) => {
        const [x, y] = pt(i, Math.max(0.08, s[d]))
        return <circle key={d} cx={x} cy={y} r="2.6" fill={DIM_COLOR[d]} />
      })}
      <text x={cx} y={118} fontSize="10" textAnchor="middle" fill="#999">帧 {s.tick}</text>
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, fontSize: 10 }}>
          {Object.entries(MODE_COLOR).map(([m, c]) => (
            <span key={m} style={{ color: '#aaa' }}><span style={{ color: c }}>■</span>{MODE_LABEL[m] ?? m}</span>
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
  const v = snap?.emotion.valence ?? 0
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
            <Radar s={snap.state} />
            <div style={{ flex: 1, fontSize: 11, color: '#bbb' }}>
              {DIMENSIONS.map((d) => (
                <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                  <span style={{ width: 14, color: DIM_COLOR[d] }}>{DIM_LABEL[d]}</span>
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
        </>
      )}
    </div>,
    document.body,
  )
}

/** ── 桌宠形象扩展点 ─────────────────────────────────────────────
 * 新增形象：实现一个 Body 组件并登记到 PET_AVATARS（立绘/图片包可在
 * Body 内用 <img> 分层，按 vs.mood / vs.mode 切换表情层与装饰）。
 * 桌宠工具栏会按注册表顺序循环切换；id 持久化在 localStorage。 */
type Mood = 'happy' | 'tired' | 'calm'
interface PetVisualState {
  mood: Mood
  mode: string
  valence: number
  stress: number
  energy: number
  tick: number
}
interface PetAvatarProps {
  vs: PetVisualState
  /** 视线单位向量 [-1,1]（exploratory 模式下跟随鼠标，其余为 0） */
  gaze: XY
}
interface PetAvatar {
  id: string
  label: string
  Body: (p: PetAvatarProps) => ReactElement
}

function deriveVS(snap: Snap): PetVisualState {
  const v = snap.emotion.valence
  return {
    mood: v > 0.02 ? 'happy' : v < -0.02 ? 'tired' : 'calm',
    mode: snap.frameLog.at(-1)?.mode ?? 'intuitive',
    valence: v,
    stress: snap.state.stress,
    energy: snap.state.energy,
    tick: snap.state.tick,
  }
}

/** 内置形象：意识团（纯 SVG，零资源；情绪表情 + 可转动眼球） */
function BlobBody({ vs, gaze }: PetAvatarProps): ReactElement {
  const tint = vs.mood === 'happy' ? '#8fe0b4' : vs.mood === 'tired' ? '#aab4bd' : '#7fc9d6'
  const dark = vs.mood === 'tired' ? '#6c7681' : '#3d8c9a'
  // exploratory 模式强制睁眼（视线要可见）；疲惫时眼睛画成下垂弧线
  const openEyes = vs.mood !== 'tired' || vs.mode === 'exploratory'
  const mouth = vs.mood === 'happy'
    ? 'M40,62 Q48,71 56,62'
    : vs.mood === 'tired' ? 'M43,66 Q48,61 53,66' : 'M43,64 L53,64'
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
      {vs.mood === 'happy' && (
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
  blob: { id: 'blob', label: '意识团', Body: BlobBody },
}

/** ── 意识桌宠悬浮层 ───────────────────────────────────────────── */
function PetWindow({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const snap = useSnap()
  const { pos, handleRef, movedRef } = useFixedDrag<HTMLDivElement>(petPosKey, { w: 104, h: 128 }, () => ({ x: globalThis.innerWidth - 160, y: globalThis.innerHeight - 232 }))
  const bodyRef = useRef<HTMLDivElement>(null)
  const [gaze, setGaze] = useState<XY>({ x: 0, y: 0 })
  const [pops, setPops] = useState<{ id: number; n: number }[]>([])
  const [hop, setHop] = useState(0)
  const popId = useRef(0)
  const lastTick = useRef<number | null>(null)
  const [avatarId, setAvatarId] = useState(() => {
    const saved = lsGet(AVATAR_KEY)
    return saved && PET_AVATARS[saved] ? saved : 'blob'
  })

  const vs = snap ? deriveVS(snap) : null

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

  // exploratory：眼球跟随鼠标（相对桌宠中心的单位向量）
  useEffect(() => {
    if (vs?.mode !== 'exploratory') {
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
  }, [vs?.mode])

  const cycleAvatar = () => {
    const ids = Object.keys(PET_AVATARS)
    const next = ids[(ids.indexOf(avatarId) + 1) % ids.length]
    setAvatarId(next)
    lsSet(AVATAR_KEY, next)
  }
  const avatar = PET_AVATARS[avatarId] ?? PET_AVATARS.blob
  const haloClass = vs?.mood === 'happy' ? 'laap-halo-good' : vs?.mood === 'tired' ? 'laap-halo-bad' : 'laap-halo-calm'
  const aria = vs
    ? `意识桌宠：${MOOD_LABEL[vs.mood]}·${MODE_LABEL[vs.mode] ?? vs.mode}，tick ${vs.tick}`
    : '意识桌宠：等待内核应答'

  return createPortal(
    <div
      ref={handleRef}
      className="laap-petroot"
      role="img"
      aria-label={aria}
      onClick={() => { if (!movedRef.current) setHop((h) => h + 1) }}
      style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 9999, width: 104, cursor: 'grab', userSelect: 'none', touchAction: 'none' }}
    >
      {/* tick +N 浮字 */}
      {pops.map((p) => (
        <span key={p.id} className="laap-rise"
          style={{ left: '50%', top: -4, marginLeft: -16, fontSize: 13, color: '#7fe0c0' }}>+{p.n}</span>
      ))}
      {/* 情绪光晕 */}
      <div className={`laap-halo ${haloClass}`} style={{ left: -10, top: 4, width: 112, height: 112 }} />
      {/* deliberate 思考气泡 */}
      {vs?.mode === 'deliberate' && (
        <div style={{
          position: 'absolute', left: 84, top: 14, background: '#23272e', border: '1px solid #ffffff1a',
          borderRadius: 10, padding: '3px 7px', fontSize: 13, lineHeight: 1, color: '#cfd6dd',
          letterSpacing: 2, whiteSpace: 'nowrap', pointerEvents: 'none',
        }} className="laap-dots">
          <span>·</span><span>·</span><span>·</span>
        </div>
      )}
      {/* 身体（外层 hop 点击反馈，内层 bob 呼吸浮动） */}
      <div ref={bodyRef} key={hop} className={hop > 0 ? 'laap-hop' : undefined}
        style={{ position: 'relative', width: 92, height: 92, margin: '8px auto 0' }}>
        <div className="laap-bob" style={{ width: 92, height: 92 }}>
          {snap ? <avatar.Body vs={vs!} gaze={gaze} /> : <BubbleWaiting />}
        </div>
      </div>
      <div style={{ textAlign: 'center', fontSize: 10, color: '#9aa2ab', textShadow: '0 1px 3px #000', pointerEvents: 'none' }}>
        {vs ? `${MODE_LABEL[vs.mode] ?? vs.mode} · ${MOOD_LABEL[vs.mood]}` : '连接中…'}
      </div>
      {/* hover 工具栏：回雷达 / 切形象 / 关闭（按钮 mousedown 冒泡仅置位拖拽，
          未移动即不视为拖拽，不影响 click） */}
      <div className="laap-toolbar" style={{ position: 'absolute', right: -12, top: 34, display: 'flex', flexDirection: 'column', gap: 4 }}>
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
