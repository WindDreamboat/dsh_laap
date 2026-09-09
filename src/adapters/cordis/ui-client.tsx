/**
 * laap-ui — 意识面板浏览器端（Client 半区，双面插件的 UI 半边）
 *
 * 在 sidebar 底部动作区注册「意识之球」指示器；点击展开面板：
 *  - 五维雷达图（Ψ 状态向量，SVG 手绘零依赖）
 *  - 情绪价与需求剥夺条
 *  - 意识流时间线（近 32 帧的模式走向与显著性柱）
 * 数据通道：Connection RPC 独立频道（POST /laap/snapshot；/api 是网关保留频道，
 * 第三方插件不得 intercept），与 dsh 前端共享同一 React 实例（不自行打包 react）。
 */
import { useState, useEffect } from 'react'
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
  async call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>> {
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
    return body.result as RpcResult<unknown>
  },
}

/** 轮询意识快照（3s），失败静默保留旧值 */
function useSnapshot(active: boolean): Snap | null {
  const [snap, setSnap] = useState<Snap | null>(null)
  useEffect(() => {
    if (!active) return
    let stop = false
    const pull = async () => {
      try {
        const r = await rpc.call('/laap', 'snapshot', {})
        if (r.ok && !stop) setSnap(r.value as Snap)
      } catch { /* 宿主离线/未装 laap：维持空态 */ }
    }
    void pull()
    const timer = setInterval(pull, 3000)
    return () => { stop = true; clearInterval(timer) }
  }, [active])
  return snap
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
      <text x={cx} y={118} fontSize="10" textAnchor="middle" fill="#999">tick {s.tick}</text>
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
          <div key={f.tick} title={`tick ${f.tick} ${f.mode} ${f.qualia.join('·')}`}
            style={{ flex: 1, minWidth: 3, height: `${Math.max(8, f.salience * 100)}%`, background: MODE_COLOR[f.mode] ?? '#888', borderRadius: 2, opacity: 0.85 }} />
        ))}
        {recent.length === 0 && <div style={{ fontSize: 11, color: '#777' }}>（尚无广播帧）</div>}
      </div>
      {recent.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, fontSize: 10 }}>
          {Object.entries(MODE_COLOR).map(([m, c]) => (
            <span key={m} style={{ color: '#aaa' }}><span style={{ color: c }}>■</span>{m}</span>
          ))}
        </div>
      )}
    </div>
  )
}

/** ── 面板主体 ─────────────────────────────────────────────────── */
function LaapPanel({ onClose }: { onClose: () => void }) {
  const snap = useSnapshot(true)
  if (!snap) {
    return (
      <div style={panelStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <b>意识状态</b><button onClick={onClose} style={btn}>✕</button>
        </div>
        <div style={{ color: '#999', padding: '18px 0', textAlign: 'center' }}>等待宿主意识内核应答…</div>
      </div>
    )
  }
  const v = snap.emotion.valence
  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <b>意识状态</b>
        <span style={{ fontSize: 11, color: v >= 0 ? '#4fae6d' : '#e05d5d' }}>
          情绪 {v >= 0 ? '↑' : '↓'} {v.toFixed(3)}
        </span>
        <button onClick={onClose} style={btn}>✕</button>
      </div>
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
    </div>
  )
}

/** ── 侧栏指示器（常驻小球：能量环 + 压力闪烁）──────────────────── */
function LaapOrb() {
  const [open, setOpen] = useState(false)
  const snap = useSnapshot(true) // 常驻轮询以驱动小球
  const stress = snap?.state.stress ?? 0
  const energy = snap?.state.energy ?? 0.5
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="意识状态面板"
        style={{
          width: 22, height: 22, borderRadius: '50%', cursor: 'pointer', border: 'none',
          background: `conic-gradient(#4f9dae ${energy * 360}deg, #6663 0deg)`,
          boxShadow: stress > 0.55 ? `0 0 ${4 + stress * 8}px #e05d5daa` : 'none',
          opacity: 0.9,
        }}
      />
      {open && (
        <div style={{ position: 'absolute', bottom: 30, left: 0, zIndex: 40 }}>
          <LaapPanel onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}

const panelStyle: React.CSSProperties = {
  width: 280, background: '#1e2126f2', color: '#ddd', borderRadius: 10,
  border: '1px solid #ffffff1a', padding: 10, boxShadow: '0 8px 32px #000a', fontSize: 12,
}
const btn: React.CSSProperties = { background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 12 }

export function apply(ctx: Context) {
  // 挂进侧栏底部动作区（list 槽位，注册需带 id）
  ctx.slots.inject('sidebar.footer.action', () => {
    const dispose = ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'laap-consciousness', order: 20 },
      LaapOrb,
    )
    return () => dispose()
  })
}

