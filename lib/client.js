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

// src/ui-client.tsx
var ui_client_exports = {};
__export(ui_client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(ui_client_exports);
var import_react = require("react");
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
function useSnapshot(active) {
  const [snap, setSnap] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    if (!active) return;
    let stop = false;
    const pull = async () => {
      try {
        const r = await rpc.call("/laap", "snapshot", {});
        if (r.ok && !stop) setSnap(r.value);
      } catch {
      }
    };
    void pull();
    const timer = setInterval(pull, 3e3);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [active]);
  return snap;
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
      "tick ",
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
          title: `tick ${f.tick} ${f.mode} ${f.qualia.join("\xB7")}`,
          style: { flex: 1, minWidth: 3, height: `${Math.max(8, f.salience * 100)}%`, background: MODE_COLOR[f.mode] ?? "#888", borderRadius: 2, opacity: 0.85 }
        },
        f.tick
      )),
      recent.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 11, color: "#777" }, children: "\uFF08\u5C1A\u65E0\u5E7F\u64AD\u5E27\uFF09" })
    ] }),
    recent.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6, fontSize: 10 }, children: Object.entries(MODE_COLOR).map(([m, c]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { color: "#aaa" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: c }, children: "\u25A0" }),
      m
    ] }, m)) })
  ] });
}
function LaapPanel({ onClose }) {
  const snap = useSnapshot(true);
  if (!snap) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: panelStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", justifyContent: "space-between" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "\u610F\u8BC6\u72B6\u6001" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: onClose, style: btn, children: "\u2715" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { color: "#999", padding: "18px 0", textAlign: "center" }, children: "\u7B49\u5F85\u5BBF\u4E3B\u610F\u8BC6\u5185\u6838\u5E94\u7B54\u2026" })
    ] });
  }
  const v = snap.emotion.valence;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: panelStyle, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "\u610F\u8BC6\u72B6\u6001" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { fontSize: 11, color: v >= 0 ? "#4fae6d" : "#e05d5d" }, children: [
        "\u60C5\u7EEA ",
        v >= 0 ? "\u2191" : "\u2193",
        " ",
        v.toFixed(3)
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: onClose, style: btn, children: "\u2715" })
    ] }),
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
  ] });
}
function LaapOrb() {
  const [open, setOpen] = (0, import_react.useState)(false);
  const snap = useSnapshot(true);
  const stress = snap?.state.stress ?? 0;
  const energy = snap?.state.energy ?? 0.5;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { position: "relative" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        onClick: () => setOpen((o) => !o),
        title: "\u610F\u8BC6\u72B6\u6001\u9762\u677F",
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
    open && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { position: "absolute", bottom: 30, left: 0, zIndex: 40 }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LaapPanel, { onClose: () => setOpen(false) }) })
  ] });
}
var panelStyle = {
  width: 280,
  background: "#1e2126f2",
  color: "#ddd",
  borderRadius: 10,
  border: "1px solid #ffffff1a",
  padding: 10,
  boxShadow: "0 8px 32px #000a",
  fontSize: 12
};
var btn = { background: "none", border: "none", color: "#aaa", cursor: "pointer", fontSize: 12 };
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
