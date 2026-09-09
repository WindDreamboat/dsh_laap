window.__ModuleLoader__.load({ id: "dsh-laap", factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/adapters/cordis/ui-client.tsx
var ui_client_exports = {};
__export(ui_client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(ui_client_exports);
var import_react = require("react");
var import_react_dom = require("react-dom");
var import_jsx_runtime = require("react/jsx-runtime");
var name = "laap-ui";
var inject = ["slots"];
var DIMENSIONS = ["stress", "confidence", "curiosity", "relatedness", "energy"];
var DIM_LABEL = { stress: "\u538B", confidence: "\u4FE1", curiosity: "\u5947", relatedness: "\u8FDE", energy: "\u80FD" };
var DIM_COLOR = {
  stress: "#e05d5d",
  confidence: "#4fae6d",
  curiosity: "#e0a13d",
  relatedness: "#5d8fe0",
  energy: "#9a6de0"
};
var MODE_COLOR = {
  intuitive: "#8a8f98",
  deliberate: "#4fae6d",
  analytic: "#5d8fe0",
  creative: "#9a6de0",
  reflective: "#e0a13d",
  exploratory: "#e0704f"
};
var MODE_LABEL = {
  intuitive: "\u76F4\u89C9",
  deliberate: "\u601D\u8003",
  analytic: "\u5206\u6790",
  creative: "\u521B\u9020",
  reflective: "\u53CD\u601D",
  exploratory: "\u63A2\u7D22"
};
var MOOD_LABEL = { happy: "\u5F00\u5FC3", tired: "\u75B2\u60EB", calm: "\u5E73\u9759" };
var VIEW_KEY = "laap:view";
var AVATAR_KEY = "laap:avatar";
var radarPosKey = "laap:pos:radar";
var petPosKey = "laap:pos:pet";
var INTERNAL_BASE = "http://dsh.internal";
function resolveBase() {
  const loc = globalThis.location;
  return loc?.origin && loc.origin !== "null" ? loc.origin : INTERNAL_BASE;
}
function simpleUuid() {
  const g = globalThis;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0, v = c === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}
var rpc = {
  async call(channel, endpoint, payload) {
    const rpcId = simpleUuid();
    const url = `${resolveBase()}${channel}/${endpoint}`;
    const res = await globalThis.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload })
    });
    if (!res.ok) throw new Error(`RPC transport failure: ${channel}/${endpoint} \u2192 HTTP ${res.status}`);
    const body = await res.json();
    if (body.type !== "server-response" || body.rpcId !== rpcId || !body.result) {
      throw new Error(`RPC envelope mismatch for ${endpoint}`);
    }
    return body.result;
  }
};
var snapCache = null;
var snapListeners = /* @__PURE__ */ new Set();
var snapTimer = null;
var inflight = false;
async function pullSnap() {
  if (inflight) return;
  inflight = true;
  try {
    const r = await rpc.call("/laap", "snapshot", {});
    if (r.ok) {
      snapCache = r.value;
      for (const l of snapListeners) l(snapCache);
    }
  } catch {
  } finally {
    inflight = false;
  }
}
function subscribeSnap(l) {
  snapListeners.add(l);
  if (snapListeners.size === 1) {
    void pullSnap();
    snapTimer = setInterval(pullSnap, 3e3);
  }
  l(snapCache);
  return () => {
    snapListeners.delete(l);
    if (snapListeners.size === 0 && snapTimer !== null) {
      clearInterval(snapTimer);
      snapTimer = null;
    }
  };
}
function useSnap() {
  const [snap, setSnap] = (0, import_react.useState)(snapCache);
  (0, import_react.useEffect)(() => subscribeSnap(setSnap), []);
  return snap;
}
function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch {
  }
}
var STYLE_ID = "laap-pet-style";
function injectStyle() {
  const doc = globalThis.document;
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement("style");
  el.id = STYLE_ID;
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
}`;
  doc.head.appendChild(el);
}
injectStyle();
function clampPos(p, w, h) {
  const W = globalThis.innerWidth || 1280;
  const H = globalThis.innerHeight || 720;
  return {
    x: Math.min(Math.max(4, p.x), Math.max(4, W - w)),
    y: Math.min(Math.max(4, p.y), Math.max(4, H - h))
  };
}
function loadPos(key, w, h, fallback) {
  const raw = lsGet(key);
  if (raw) {
    const [x, y] = raw.split(",").map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) return clampPos({ x, y }, w, h);
  }
  return clampPos(fallback(), w, h);
}
function useFixedDrag(key, size, fallback) {
  const [pos, setPos] = (0, import_react.useState)(() => loadPos(key, size.w, size.h, fallback));
  const posRef = (0, import_react.useRef)(pos);
  posRef.current = pos;
  const handleRef = (0, import_react.useRef)(null);
  const drag = (0, import_react.useRef)(null);
  const movedRef = (0, import_react.useRef)(false);
  (0, import_react.useEffect)(() => {
    const el = handleRef.current;
    if (!el) return;
    const down = (e) => {
      movedRef.current = false;
      drag.current = { sx: e.clientX, sy: e.clientY, ox: posRef.current.x, oy: posRef.current.y, moved: false, x: posRef.current.x, y: posRef.current.y };
    };
    const move = (e) => {
      const d = drag.current;
      if (!d) return;
      if (Math.abs(e.clientX - d.sx) > 3 || Math.abs(e.clientY - d.sy) > 3) d.moved = true;
      const np = clampPos({ x: e.clientX - d.sx + d.ox, y: e.clientY - d.sy + d.oy }, size.w, size.h);
      d.x = np.x;
      d.y = np.y;
      setPos(np);
    };
    const up = () => {
      const d = drag.current;
      if (d) {
        if (d.moved) lsSet(key, `${d.x},${d.y}`);
        movedRef.current = d.moved;
        drag.current = null;
      }
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [key, size.w, size.h]);
  return { pos, handleRef, movedRef };
}
function Radar({ s }) {
  const cx = 60, cy = 62, R = 44;
  const pt = (i, r) => {
    const a = Math.PI * 2 * i / 5 - Math.PI / 2;
    return [cx + Math.cos(a) * R * r, cy + Math.sin(a) * R * r];
  };
  const ring = (r) => DIMENSIONS.map((_, i) => pt(i, r).join(",")).join(" ");
  const shape = DIMENSIONS.map((d, i) => pt(i, Math.max(0.08, s[d]))).map((p) => p.join(",")).join(" ");
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: "120", height: "120", viewBox: "0 0 120 124", role: "img", "aria-label": "\u610F\u8BC6\u72B6\u6001\u96F7\u8FBE\u56FE", children: [
    [1, 2 / 3, 1 / 3].map((r) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("polygon", { points: ring(r), fill: "none", stroke: "#8883", strokeWidth: "1" }, r)),
    DIMENSIONS.map((d, i) => {
      const [x, y] = pt(i, 0.62);
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("text", { x, y: y + 4, fontSize: "11", textAnchor: "middle", fill: DIM_COLOR[d], children: DIM_LABEL[d] }, d);
    }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("polygon", { points: shape, fill: "#4f9dae33", stroke: "#4f9dae", strokeWidth: "1.5" }),
    DIMENSIONS.map((d, i) => {
      const [x, y] = pt(i, Math.max(0.08, s[d]));
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: x, cy: y, r: "2.6", fill: DIM_COLOR[d] }, d);
    }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("text", { x: cx, y: 118, fontSize: "10", textAnchor: "middle", fill: "#999", children: [
      "\u5E27 ",
      s.tick
    ] })
  ] });
}
function Timeline({ frames }) {
  const recent = frames.slice(-32);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 8 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { fontSize: 11, color: "#999", marginBottom: 4 }, children: [
      "\u610F\u8BC6\u6D41\uFF08\u8FD1 ",
      recent.length,
      " \u5E27\uFF09"
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 2, alignItems: "flex-end", height: 44 }, children: [
      recent.map((f) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "div",
        {
          title: `\u5E27 ${f.tick} \xB7 ${MODE_LABEL[f.mode] ?? f.mode} \xB7 ${f.qualia.join("\xB7")}`,
          style: { flex: 1, minWidth: 3, height: `${Math.max(8, f.salience * 100)}%`, background: MODE_COLOR[f.mode] ?? "#888", borderRadius: 2, opacity: 0.85 }
        },
        f.tick
      )),
      recent.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 11, color: "#777" }, children: "\uFF08\u5C1A\u65E0\u5E7F\u64AD\u5E27\uFF09" })
    ] }),
    recent.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6, fontSize: 10 }, children: Object.entries(MODE_COLOR).map(([m, c]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { color: "#aaa" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: c }, children: "\u25A0" }),
      MODE_LABEL[m] ?? m
    ] }, m)) })
  ] });
}
function RadarWindow({ onPet, onClose }) {
  const snap = useSnap();
  const { pos, handleRef } = useFixedDrag(radarPosKey, { w: 300, h: 380 }, () => ({ x: globalThis.innerWidth - 316, y: 96 }));
  const v = snap?.emotion.valence ?? 0;
  return (0, import_react_dom.createPortal)(
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "laap-pop", style: { ...panelStyle, position: "fixed", left: pos.x, top: pos.y, zIndex: 9999, width: 300 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { ref: handleRef, style: { display: "flex", alignItems: "center", gap: 6, cursor: "move", marginBottom: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "\u610F\u8BC6\u72B6\u6001" }),
        snap && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { fontSize: 11, color: v >= 0 ? "#4fae6d" : "#e05d5d" }, children: [
          v >= 0 ? "\u2191" : "\u2193",
          " ",
          v.toFixed(2)
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { title: "\u96F7\u8FBE\u89C6\u56FE\uFF08\u5F53\u524D\uFF09", style: chip(true), children: "\u{1F4CA}" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: onPet, title: "\u5207\u6362\u4E3A\u610F\u8BC6\u684C\u5BA0", style: chip(false), children: "\u{1F43E}" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: onClose, title: "\u6536\u8D77", style: btn, children: "\u2715" })
      ] }),
      !snap ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { color: "#999", padding: "18px 0", textAlign: "center" }, children: "\u7B49\u5F85\u5BBF\u4E3B\u610F\u8BC6\u5185\u6838\u5E94\u7B54\u2026" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 10, alignItems: "center" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Radar, { s: snap.state }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { flex: 1, fontSize: 11, color: "#bbb" }, children: [
            DIMENSIONS.map((d) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 4, marginBottom: 3 }, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { width: 14, color: DIM_COLOR[d] }, children: DIM_LABEL[d] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { flex: 1, height: 5, background: "#8883", borderRadius: 3 }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { width: `${snap.state[d] * 100}%`, height: "100%", background: DIM_COLOR[d], borderRadius: 3 } }) }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { width: 26, textAlign: "right" }, children: snap.state[d].toFixed(2) })
            ] }, d)),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 6 }, children: [
              "\u4FE1\u5FC3\u6821\u51C6 ",
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { style: { color: "#4fae6d" }, children: snap.monitor.calibrated.toFixed(2) }),
              " \xB7 ",
              "\u6280\u80FD ",
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: snap.skills })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 10, color: "#888", marginTop: 4 }, children: snap.restoredFrom ? `\u610F\u8BC6\u5EF6\u7EED\u81EA ${new Date(snap.restoredFrom.savedAt).toLocaleString()}` : "\u65B0\u751F\u610F\u8BC6" })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Timeline, { frames: snap.frameLog })
      ] })
    ] }),
    document.body
  );
}
function deriveVS(snap) {
  const v = snap.emotion.valence;
  return {
    mood: v > 0.02 ? "happy" : v < -0.02 ? "tired" : "calm",
    mode: snap.frameLog.at(-1)?.mode ?? "intuitive",
    valence: v,
    stress: snap.state.stress,
    energy: snap.state.energy,
    tick: snap.state.tick
  };
}
function BlobBody({ vs, gaze }) {
  const tint = vs.mood === "happy" ? "#8fe0b4" : vs.mood === "tired" ? "#aab4bd" : "#7fc9d6";
  const dark = vs.mood === "tired" ? "#6c7681" : "#3d8c9a";
  const openEyes = vs.mood !== "tired" || vs.mode === "exploratory";
  const mouth = vs.mood === "happy" ? "M40,62 Q48,71 56,62" : vs.mood === "tired" ? "M43,66 Q48,61 53,66" : "M43,64 L53,64";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: "92", height: "92", viewBox: "0 0 100 100", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("defs", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("radialGradient", { id: "laap-blob-grad", cx: "38%", cy: "30%", r: "78%", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("stop", { offset: "0%", stopColor: "#ffffff", stopOpacity: "0.55" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("stop", { offset: "38%", stopColor: tint }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("stop", { offset: "100%", stopColor: dark })
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ellipse", { cx: "50", cy: "54", rx: "34", ry: "32", fill: "url(#laap-blob-grad)", stroke: "#ffffff22" }),
    vs.mood === "happy" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "29", cy: "58", r: "4.5", fill: "#ef8fa0", opacity: "0.55" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "71", cy: "58", r: "4.5", fill: "#ef8fa0", opacity: "0.55" })
    ] }),
    openEyes ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("g", { className: "laap-eye", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ellipse", { cx: "36", cy: "46", rx: "7.5", ry: "8.5", fill: "#fff" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: 36 + gaze.x * 3, cy: 46 + gaze.y * 2.4, r: "3.4", fill: "#2a2f37" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("g", { className: "laap-eye", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ellipse", { cx: "62", cy: "46", rx: "7.5", ry: "8.5", fill: "#fff" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: 62 + gaze.x * 3, cy: 46 + gaze.y * 2.4, r: "3.4", fill: "#2a2f37" })
      ] })
    ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { className: "laap-eye", d: "M29,48 Q36,42.5 43,48", fill: "none", stroke: "#2a2f37", strokeWidth: "2.2", strokeLinecap: "round" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { className: "laap-eye", d: "M55,48 Q62,42.5 69,48", fill: "none", stroke: "#2a2f37", strokeWidth: "2.2", strokeLinecap: "round" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("text", { x: "72", y: "34", fontSize: "11", fill: "#dfe6ea", opacity: "0.8", children: "z" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: mouth, fill: "none", stroke: "#2a2f37", strokeWidth: "2.4", strokeLinecap: "round" })
  ] });
}
var PET_AVATARS = {
  blob: { id: "blob", label: "\u610F\u8BC6\u56E2", Body: BlobBody }
};
function PetWindow({ onBack, onClose }) {
  const snap = useSnap();
  const { pos, handleRef, movedRef } = useFixedDrag(petPosKey, { w: 104, h: 128 }, () => ({ x: globalThis.innerWidth - 160, y: globalThis.innerHeight - 232 }));
  const bodyRef = (0, import_react.useRef)(null);
  const [gaze, setGaze] = (0, import_react.useState)({ x: 0, y: 0 });
  const [pops, setPops] = (0, import_react.useState)([]);
  const [hop, setHop] = (0, import_react.useState)(0);
  const popId = (0, import_react.useRef)(0);
  const lastTick = (0, import_react.useRef)(null);
  const [avatarId, setAvatarId] = (0, import_react.useState)(() => {
    const saved = lsGet(AVATAR_KEY);
    return saved && PET_AVATARS[saved] ? saved : "blob";
  });
  const vs = snap ? deriveVS(snap) : null;
  (0, import_react.useEffect)(() => {
    if (!snap) return;
    const t = snap.state.tick;
    if (lastTick.current === null) {
      lastTick.current = t;
      return;
    }
    const delta = t - lastTick.current;
    lastTick.current = t;
    if (delta > 0) {
      const id = ++popId.current;
      setPops((p) => [...p.slice(-5), { id, n: delta }]);
      const timer = setTimeout(() => setPops((p) => p.filter((x) => x.id !== id)), 1200);
      return () => clearTimeout(timer);
    }
  }, [snap]);
  (0, import_react.useEffect)(() => {
    if (vs?.mode !== "exploratory") {
      setGaze({ x: 0, y: 0 });
      return;
    }
    const onMove = (e) => {
      const el = bodyRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const len = Math.hypot(dx, dy) || 1;
      setGaze({ x: Math.max(-1, Math.min(1, dx / len)), y: Math.max(-1, Math.min(1, dy / len)) });
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [vs?.mode]);
  const cycleAvatar = () => {
    const ids = Object.keys(PET_AVATARS);
    const next = ids[(ids.indexOf(avatarId) + 1) % ids.length];
    setAvatarId(next);
    lsSet(AVATAR_KEY, next);
  };
  const avatar = PET_AVATARS[avatarId] ?? PET_AVATARS.blob;
  const haloClass = vs?.mood === "happy" ? "laap-halo-good" : vs?.mood === "tired" ? "laap-halo-bad" : "laap-halo-calm";
  const aria = vs ? `\u610F\u8BC6\u684C\u5BA0\uFF1A${MOOD_LABEL[vs.mood]}\xB7${MODE_LABEL[vs.mode] ?? vs.mode}\uFF0Ctick ${vs.tick}` : "\u610F\u8BC6\u684C\u5BA0\uFF1A\u7B49\u5F85\u5185\u6838\u5E94\u7B54";
  return (0, import_react_dom.createPortal)(
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        ref: handleRef,
        className: "laap-petroot",
        role: "img",
        "aria-label": aria,
        onClick: () => {
          if (!movedRef.current) setHop((h) => h + 1);
        },
        style: { position: "fixed", left: pos.x, top: pos.y, zIndex: 9999, width: 104, cursor: "grab", userSelect: "none", touchAction: "none" },
        children: [
          pops.map((p) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "span",
            {
              className: "laap-rise",
              style: { left: "50%", top: -4, marginLeft: -16, fontSize: 13, color: "#7fe0c0" },
              children: [
                "+",
                p.n
              ]
            },
            p.id
          )),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: `laap-halo ${haloClass}`, style: { left: -10, top: 4, width: 112, height: 112 } }),
          vs?.mode === "deliberate" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: {
            position: "absolute",
            left: 84,
            top: 14,
            background: "#23272e",
            border: "1px solid #ffffff1a",
            borderRadius: 10,
            padding: "3px 7px",
            fontSize: 13,
            lineHeight: 1,
            color: "#cfd6dd",
            letterSpacing: 2,
            whiteSpace: "nowrap",
            pointerEvents: "none"
          }, className: "laap-dots", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\xB7" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\xB7" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\xB7" })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "div",
            {
              ref: bodyRef,
              className: hop > 0 ? "laap-hop" : void 0,
              style: { position: "relative", width: 92, height: 92, margin: "8px auto 0" },
              children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "laap-bob", style: { width: 92, height: 92 }, children: snap ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(avatar.Body, { vs, gaze }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(BubbleWaiting, {}) })
            },
            hop
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { textAlign: "center", fontSize: 10, color: "#9aa2ab", textShadow: "0 1px 3px #000", pointerEvents: "none" }, children: vs ? `${MODE_LABEL[vs.mode] ?? vs.mode} \xB7 ${MOOD_LABEL[vs.mood]}` : "\u8FDE\u63A5\u4E2D\u2026" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "laap-toolbar", style: { position: "absolute", right: -12, top: 34, display: "flex", flexDirection: "column", gap: 4 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: onBack, title: "\u56DE\u5230\u96F7\u8FBE\u89C6\u56FE", style: miniBtn, children: "\u{1F4CA}" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: cycleAvatar, title: `\u5207\u6362\u5F62\u8C61\uFF08\u5F53\u524D\uFF1A${avatar.label}\uFF09`, style: miniBtn, children: "\u{1F504}" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: onClose, title: "\u6536\u8D77\u684C\u5BA0", style: miniBtn, children: "\u2715" })
          ] })
        ]
      }
    ),
    document.body
  );
}
function BubbleWaiting() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: "92", height: "92", viewBox: "0 0 100 100", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ellipse", { cx: "50", cy: "54", rx: "34", ry: "32", fill: "#3a4149", stroke: "#ffffff22" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "38", cy: "48", r: "3", fill: "#9aa2ab" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "60", cy: "48", r: "3", fill: "#9aa2ab" })
  ] });
}
function Overlay({ onClose }) {
  const [view, setView] = (0, import_react.useState)(() => lsGet(VIEW_KEY) === "pet" ? "pet" : "radar");
  const go = (v) => {
    setView(v);
    lsSet(VIEW_KEY, v);
  };
  return view === "radar" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(RadarWindow, { onPet: () => go("pet"), onClose }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PetWindow, { onBack: () => go("radar"), onClose });
}
function LaapOrb() {
  const [open, setOpen] = (0, import_react.useState)(false);
  const snap = useSnap();
  const stress = snap?.state.stress ?? 0;
  const energy = snap?.state.energy ?? 0.5;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { position: "relative" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        onClick: () => setOpen((o) => !o),
        title: "\u610F\u8BC6\u72B6\u6001\u9762\u677F",
        "aria-expanded": open,
        style: {
          width: 22,
          height: 22,
          borderRadius: "50%",
          cursor: "pointer",
          border: "none",
          background: `conic-gradient(#4f9dae ${energy * 360}deg, #6663 0deg)`,
          boxShadow: stress > 0.55 ? `0 0 ${4 + stress * 8}px #e05d5daa` : "none",
          opacity: 0.9
        }
      }
    ),
    open && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Overlay, { onClose: () => setOpen(false) })
  ] });
}
var panelStyle = {
  background: "#1e2126f2",
  color: "#ddd",
  borderRadius: 10,
  border: "1px solid #ffffff1a",
  padding: 10,
  boxShadow: "0 8px 32px #000a",
  fontSize: 12
};
var btn = { background: "none", border: "none", color: "#aaa", cursor: "pointer", fontSize: 12, padding: "2px 4px" };
var miniBtn = { ...btn, background: "#23272eee", border: "1px solid #ffffff1a", borderRadius: 6, fontSize: 11, padding: "2px 5px" };
function chip(active) {
  return {
    ...btn,
    padding: "2px 6px",
    borderRadius: 6,
    background: active ? "#4f9dae33" : "none",
    color: active ? "#9fe0ea" : "#aaa",
    border: active ? "1px solid #4f9dae55" : "1px solid transparent"
  };
}
function apply(ctx) {
  ctx.slots.inject("sidebar.footer.action", () => {
    const dispose = ctx.slots.register(
      { name: "sidebar.footer.action", id: "laap-consciousness", order: 20 },
      LaapOrb
    );
    return () => dispose();
  });
}
return module.exports;
} });
