// 临时验证脚本：用极简 DOM/Canvas 桩驱动构建产物中的台球游戏主循环。
// 场景：开启「启动列表图标」且图标/IPC 迟迟不返回（invoke 永不 resolve、Image 永不 onload），
// 验证首帧渲染不再因场上无球而崩溃、渲染循环持续存活、球被实际绘制。
// 用法：node scripts/test-game-loop.mjs

import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = path.join(root, "dist", "assets");
const gameJs = readdirSync(assetsDir).find((f) => /^game-.*\.js$/.test(f));
if (!gameJs) { console.error("FAIL: 未找到 dist/assets/game-*.js"); process.exit(1); }

// ---------- 桩 ----------
let arcCalls = 0;
const grad = { addColorStop() {} };
function makeCtx() {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === "createRadialGradient" || prop === "createLinearGradient") return () => grad;
      return () => { if (prop === "arc") arcCalls++; };
    },
    set() { return true; },
  });
}

const elements = new Map();
function makeEl(sel) {
  const el = {
    style: {},
    hidden: false,
    checked: false,
    value: "15",
    clientWidth: 1060,
    clientHeight: 600,
    width: 0,
    height: 0,
    innerHTML: "",
    textContent: "",
    onclick: null,
    onchange: null,
    addEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture() { return false; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1060, height: 600 }; },
    getContext() { return makeCtx(); },
  };
  elements.set(sel, el);
  return el;
}

globalThis.window = globalThis;
window.devicePixelRatio = 1;
window.addEventListener = () => {};
globalThis.getComputedStyle = () => ({ paddingLeft: "10", paddingRight: "10", paddingTop: "10", paddingBottom: "10" });
globalThis.document = {
  querySelector: (sel) => elements.get(sel) ?? makeEl(sel),
  createElement: (tag) => makeEl(`<${tag}>`),
  querySelectorAll: () => [],
  head: { appendChild() {} },
};
// 开启「启动列表图标」，且图标加载永不完成（最坏情况）
globalThis.localStorage = {
  getItem: (k) => (k === "suqi-game-options" ? JSON.stringify({ guide: true, icons: true, duo: false, count: 15 }) : null),
  setItem() {},
};
globalThis.Image = class { set src(_v) { /* 永不触发 onload/onerror */ } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
// 模拟真实应用中 IPC 迟迟不返回（窗口刚创建、后端繁忙等）：invoke 永不 resolve
window.__TAURI_INTERNALS__ = { invoke: () => new Promise(() => {}) };

let rafCb = null;
let rafCount = 0;
globalThis.requestAnimationFrame = (cb) => { rafCb = cb; rafCount++; return rafCount; };

// ---------- 驱动 ----------
let failed = false;
process.on("uncaughtException", (e) => { console.error("FAIL: 未捕获异常:", e); failed = true; });

await import(pathToFileURL(path.join(assetsDir, gameJs)).href);

let t = 0;
for (let i = 0; i < 30 && !failed; i++) {
  const cb = rafCb;
  rafCb = null;
  if (!cb) { console.error(`FAIL: 第 ${i + 1} 帧后渲染循环停止（requestAnimationFrame 未再注册）`); failed = true; break; }
  t += 16.7;
  try { cb(t); } catch (e) { console.error(`FAIL: 第 ${i + 1} 帧抛错:`, e); failed = true; break; }
}

const scoreHtml = elements.get("#score")?.innerHTML ?? "";
if (!failed && arcCalls < 100) { console.error(`FAIL: 球疑似未绘制（arc 调用 ${arcCalls} 次）`); failed = true; }
if (!failed && !scoreHtml.includes("已进")) { console.error(`FAIL: 记分牌未更新: ${JSON.stringify(scoreHtml)}`); failed = true; }

if (failed) process.exit(1);
console.log(`PASS: 30 帧无异常，渲染循环存活；arc 调用 ${arcCalls} 次；记分牌: ${scoreHtml}`);
process.exit(0);
