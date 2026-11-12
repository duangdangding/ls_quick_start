import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { applyAppearance, applyWindowEffect, loadConfig } from "./config";
import "./styles.css";

// 速启台球：娱乐模式，无复杂规则——全部目标球打进即结束。
// 选项：辅助线 / 用启动列表图标做球 / 双人计分。

// ---------- 台面常量（逻辑坐标，渲染时整体缩放） ----------
const PLAY_W = 1000; // 台面（库边内）宽
const PLAY_H = 500; // 台面高
const RAIL = 36; // 库边宽度（仅绘制）
const BALL_R = 13;
const POCKET_R_CORNER = 18; // 角袋半径
const POCKET_R_SIDE = 14; // 中袋半径（真实球台中袋比角袋小）
const BALL_COUNTS = [10, 15, 21, 28, 36]; // 可选目标球数量（三角行数 4/5/6/7/8）
const DEFAULT_BALL_COUNT = 15;
const MAX_DRAG = 260; // 满力度所需的拖拽距离
const MAX_SPEED = 1500; // 满力度出杆速度 px/s
const DRAG = 0.35; // 速度比例衰减 /s
const ROLL = 150; // 滚动减速 px/s²
const STOP_SPEED = 6; // 低于该速度视为静止
const REST_WALL = 0.82; // 库边弹性
const REST_BALL = 0.96; // 球间弹性

const LOGIC_W = PLAY_W + RAIL * 2;
const LOGIC_H = PLAY_H + RAIL * 2;

// 默认球色（无图标时的台球配色，超出后循环使用）
const BALL_COLORS = ["#f6c344", "#2f6fd0", "#e0492f", "#7b4fc0", "#ef7d1a", "#2e9e5b", "#8e2f38", "#2a2c38", "#d0729b", "#2fb6b6", "#c94f7c", "#5b8def", "#9b59d0", "#e0a030", "#3fbf8f", "#b8b42f"];

// 袋口：四角（大）+ 上下中袋（小）（台面坐标）
const POCKETS: Array<{ x: number; y: number; r: number }> = [
  { x: 0, y: 0, r: POCKET_R_CORNER }, { x: PLAY_W / 2, y: 0, r: POCKET_R_SIDE }, { x: PLAY_W, y: 0, r: POCKET_R_CORNER },
  { x: 0, y: PLAY_H, r: POCKET_R_CORNER }, { x: PLAY_W / 2, y: PLAY_H, r: POCKET_R_SIDE }, { x: PLAY_W, y: PLAY_H, r: POCKET_R_CORNER },
];

interface Ball {
  x: number; y: number;
  vx: number; vy: number;
  rot: number; // 滚动旋转角（俯视下球面在屏幕平面内转动）
  alive: boolean;
  cue: boolean;
  num: number; // 球号（0 = 白球）
  color: string;
  icon: HTMLImageElement | null;
}

interface GameOptions { guide: boolean; icons: boolean; duo: boolean; count: number }

// ---------- 选项持久化（本窗口 localStorage） ----------
const OPT_KEY = "suqi-game-options";
function loadOptions(): GameOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(OPT_KEY) ?? "{}");
    return {
      guide: raw.guide !== false,
      icons: !!raw.icons,
      duo: !!raw.duo,
      count: BALL_COUNTS.includes(raw.count) ? raw.count : DEFAULT_BALL_COUNT,
    };
  } catch { return { guide: true, icons: false, duo: false, count: DEFAULT_BALL_COUNT }; }
}
function saveOptions() { localStorage.setItem(OPT_KEY, JSON.stringify(opts)); }
const opts = loadOptions();

// ---------- 状态 ----------
let balls: Ball[] = [];
let aiming = false;
let aimX = 0;
let aimY = 0;
let scores = [0, 0];
let current = 0; // 当前击球的玩家（双人模式）
let shotCount = 0;
let gameOver = false;
let pottedThisShot: Ball[] = [];
let wasMoving = false;
let iconPool: HTMLImageElement[] = [];

const canvas = document.querySelector<HTMLCanvasElement>("#table")!;
const wrap = document.querySelector<HTMLElement>("#table-wrap")!;
const scoreEl = document.querySelector<HTMLElement>("#score")!;
const banner = document.querySelector<HTMLElement>("#banner")!;
const bannerTitle = document.querySelector<HTMLElement>("#banner-title")!;
const bannerDetail = document.querySelector<HTMLElement>("#banner-detail")!;
const ctx = canvas.getContext("2d")!;

// ---------- 图标 ----------
/** 从后端取启动列表图标路径并加载为图片（加载失败的丢弃） */
async function fetchIconPool(): Promise<HTMLImageElement[]> {
  let paths: string[] = [];
  try { paths = await invoke<string[]>("launcher_icons"); } catch { return []; }
  const loaded = await Promise.all(paths.map((path) => new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0 ? img : null);
    img.onerror = () => resolve(null);
    img.src = convertFileSrc(path);
  })));
  return loaded.filter((img): img is HTMLImageElement => !!img);
}

/** 给目标球分配图标：图标多于球数时随机选取，不足时循环复用 */
function assignIcons() {
  const objects = balls.filter((b) => !b.cue);
  if (!opts.icons || iconPool.length === 0) {
    objects.forEach((b) => { b.icon = null; });
    return;
  }
  const pool = [...iconPool];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  objects.forEach((ball, index) => { ball.icon = pool[index % pool.length]; });
}

// ---------- 摆球 ----------
function newRack() {
  balls = [];
  scores = [0, 0];
  current = 0;
  shotCount = 0;
  gameOver = false;
  pottedThisShot = [];
  aiming = false;
  banner.hidden = true;
  // 白球在左侧开球点
  balls.push({ x: PLAY_W * 0.25, y: PLAY_H / 2, vx: 0, vy: 0, rot: 0, alive: true, cue: true, num: 0, color: "#f5f5f0", icon: null });
  // 目标球三角：顶点朝左，按球数自动排 1+2+…+n 行
  const order = [...Array(opts.count).keys()];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const gap = BALL_R * 2 + 0.6;
  const apexX = PLAY_W * 0.68;
  const apexY = PLAY_H / 2;
  let index = 0;
  for (let row = 0; index < opts.count; row++) {
    for (let col = 0; col <= row && index < opts.count; col++) {
      const num = order[index++] + 1;
      balls.push({
        x: apexX + row * gap * 0.866,
        y: apexY + (col - row / 2) * gap,
        vx: 0, vy: 0, rot: Math.random() * Math.PI * 2, alive: true, cue: false,
        num, color: BALL_COLORS[(num - 1) % BALL_COLORS.length], icon: null,
      });
    }
  }
  assignIcons();
  updateHud();
}

/** 白球进袋后重置回开球点；被占用时沿附近找空位 */
function respotCue() {
  const cue = balls.find((b) => b.cue)!;
  const baseX = PLAY_W * 0.25;
  const baseY = PLAY_H / 2;
  const free = (x: number, y: number) =>
    x > BALL_R && x < PLAY_W - BALL_R && y > BALL_R && y < PLAY_H - BALL_R &&
    POCKETS.every((p) => Math.hypot(p.x - x, p.y - y) > p.r + BALL_R) &&
    balls.every((b) => b.cue || !b.alive || Math.hypot(b.x - x, b.y - y) >= BALL_R * 2 + 1);
  outer:
  for (let ring = 0; ring <= 200; ring += 6) {
    for (let a = 0; a < 360; a += 30) {
      const x = baseX + ring * Math.cos((a * Math.PI) / 180);
      const y = baseY + ring * Math.sin((a * Math.PI) / 180);
      if (free(x, y)) { cue.x = x; cue.y = y; break outer; }
    }
  }
  cue.vx = 0; cue.vy = 0; cue.alive = true;
}

// ---------- 物理 ----------
function cueBall(): Ball { return balls.find((b) => b.cue)!; }
function allStopped(): boolean { return balls.every((b) => !b.alive || (b.vx === 0 && b.vy === 0)); }

function pot(ball: Ball) {
  ball.alive = false;
  ball.vx = 0;
  ball.vy = 0;
  pottedThisShot.push(ball);
}

function step(dt: number) {
  if (allStopped()) return;
  const maxV = Math.max(...balls.filter((b) => b.alive).map((b) => Math.hypot(b.vx, b.vy)), 0);
  // 高速时拆子步，避免穿球 / 穿库
  const n = Math.min(10, Math.max(1, Math.ceil((maxV * dt) / (BALL_R * 0.5))));
  const h = dt / n;
  for (let s = 0; s < n; s++) {
    for (const ball of balls) {
      if (!ball.alive || (ball.vx === 0 && ball.vy === 0)) continue;
      ball.x += ball.vx * h;
      ball.y += ball.vy * h;
      // 进袋判定：袋口附近不再反弹，让球落入
      const nearPocket = POCKETS.some((p) => Math.hypot(p.x - ball.x, p.y - ball.y) < p.r + BALL_R * 0.55);
      if (nearPocket) {
        if (POCKETS.some((p) => Math.hypot(p.x - ball.x, p.y - ball.y) < p.r * 0.72)) { pot(ball); continue; }
      } else {
        if (ball.x < BALL_R) { ball.x = BALL_R; ball.vx = Math.abs(ball.vx) * REST_WALL; }
        if (ball.x > PLAY_W - BALL_R) { ball.x = PLAY_W - BALL_R; ball.vx = -Math.abs(ball.vx) * REST_WALL; }
        if (ball.y < BALL_R) { ball.y = BALL_R; ball.vy = Math.abs(ball.vy) * REST_WALL; }
        if (ball.y > PLAY_H - BALL_R) { ball.y = PLAY_H - BALL_R; ball.vy = -Math.abs(ball.vy) * REST_WALL; }
      }
      // 摩擦：比例衰减 + 线性滚动减速
      const sp = Math.hypot(ball.vx, ball.vy);
      if (sp > 0) {
        // 纯滚动：旋转角 = 滚过弧长 / 半径（俯视图下球面在屏幕平面内转动）
        ball.rot += (sp * h) / BALL_R;
        const next = Math.max(0, sp * Math.exp(-DRAG * h) - ROLL * h);
        const k = next < STOP_SPEED * 0.5 ? 0 : next / sp;
        ball.vx *= k;
        ball.vy *= k;
      }
    }
    // 球间碰撞（等质量弹性）：全体存活球两两检测，静止的球也会被撞动
    const alive = balls.filter((b) => b.alive);
    for (let i = 0; i < alive.length; i++) {
      const a = alive[i];
      for (let j = i + 1; j < alive.length; j++) {
        const b = alive[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist === 0 || dist >= BALL_R * 2) continue;
        const nx = dx / dist;
        const ny = dy / dist;
        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn < 0) {
          const impulse = (-(1 + REST_BALL) * vn) / 2;
          a.vx -= impulse * nx;
          a.vy -= impulse * ny;
          b.vx += impulse * nx;
          b.vy += impulse * ny;
        }
        const overlap = (BALL_R * 2 - dist) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;
      }
    }
  }
  // 全场静止的瞬间结算这一杆
  if (allStopped()) {
    balls.forEach((b) => { b.vx = 0; b.vy = 0; });
    if (wasMoving) { wasMoving = false; resolveTurn(); }
  } else {
    wasMoving = true;
  }
}

function resolveTurn() {
  const objects = pottedThisShot.filter((b) => !b.cue).length;
  const cueIn = pottedThisShot.some((b) => b.cue);
  if (cueIn) respotCue();
  if (opts.duo) {
    // 双人：进球继续，未进或白球进袋换人
    scores[current] += objects;
    if (objects === 0 || cueIn) current = 1 - current;
  }
  pottedThisShot = [];
  if (balls.every((b) => b.cue || !b.alive)) endGame();
  updateHud();
}

function endGame() {
  gameOver = true;
  if (opts.duo) {
    if (scores[0] === scores[1]) {
      bannerTitle.textContent = "平局！";
      bannerDetail.textContent = `双方各进 ${scores[0]} 球，共 ${shotCount} 杆`;
    } else {
      const winner = scores[0] > scores[1] ? 0 : 1;
      bannerTitle.textContent = `玩家 ${winner + 1} 获胜！`;
      bannerDetail.textContent = `${scores[0]} : ${scores[1]} · 共 ${shotCount} 杆`;
    }
  } else {
    bannerTitle.textContent = "全部清台！";
    bannerDetail.textContent = `${balls.length - 1} 个球 · 共 ${shotCount} 杆`;
  }
  banner.hidden = false;
}

function updateHud() {
  const potted = balls.filter((b) => !b.cue && !b.alive).length;
  if (opts.duo) {
    scoreEl.innerHTML =
      `<span class="${current === 0 && !gameOver ? "turn" : ""}">玩家 1：<b>${scores[0]}</b></span>` +
      `<span class="${current === 1 && !gameOver ? "turn" : ""}">玩家 2：<b>${scores[1]}</b></span>` +
      `<span>第 ${shotCount + (gameOver ? 0 : 1)} 杆</span>`;
  } else {
    scoreEl.innerHTML = `<span>已进 <b>${potted}</b> / ${balls.length - 1}</span><span>第 ${shotCount + (gameOver ? 0 : 1)} 杆</span>`;
  }
}

// ---------- 渲染 ----------
function resize() {
  const dpr = window.devicePixelRatio || 1;
  // clientWidth 含内边距，须扣除，否则画布超出内容盒被裁掉边缘
  const cs = getComputedStyle(wrap);
  const availW = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const scale = Math.min(availW / LOGIC_W, availH / LOGIC_H);
  canvas.style.width = `${Math.floor(LOGIC_W * scale)}px`;
  canvas.style.height = `${Math.floor(LOGIC_H * scale)}px`;
  canvas.width = Math.floor(LOGIC_W * scale * dpr);
  canvas.height = Math.floor(LOGIC_H * scale * dpr);
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
}

function drawBall(ball: Ball) {
  const { x, y } = ball;
  // 阴影
  ctx.beginPath();
  ctx.ellipse(x + 2, y + 3, BALL_R, BALL_R * 0.9, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,.28)";
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, BALL_R, 0, Math.PI * 2);
  ctx.clip();
  // 球体底色（高光渐变固定方向，不随球旋转）
  const grad = ctx.createRadialGradient(x - BALL_R * 0.4, y - BALL_R * 0.45, BALL_R * 0.15, x, y, BALL_R);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.25, ball.color);
  grad.addColorStop(1, ball.cue ? "#d8d8cf" : ball.color);
  ctx.fillStyle = grad;
  ctx.fillRect(x - BALL_R, y - BALL_R, BALL_R * 2, BALL_R * 2);
  // 球面图案（图标 / 号码圈 / 白球红点）随滚动旋转
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ball.rot);
  if (ball.icon) {
    const size = BALL_R * 1.7;
    ctx.drawImage(ball.icon, -size / 2, -size / 2, size, size);
  } else if (!ball.cue) {
    // 号码圈
    ctx.beginPath();
    ctx.arc(0, 0, BALL_R * 0.52, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.fill();
    ctx.fillStyle = "#26283a";
    ctx.font = `700 ${BALL_R * 0.62}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(ball.num), 0, 0.5);
  } else {
    // 白球上的红点：让滚动可见
    ctx.beginPath();
    ctx.arc(BALL_R * 0.55, 0, BALL_R * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(224,73,47,.85)";
    ctx.fill();
  }
  ctx.restore();
  // 顶部高光
  ctx.beginPath();
  ctx.ellipse(x - BALL_R * 0.3, y - BALL_R * 0.42, BALL_R * 0.34, BALL_R * 0.2, -0.6, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,.4)";
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x, y, BALL_R, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0,0,0,.35)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** 辅助线：预测白球路线，撞球时给出目标球方向，否则碰库反弹最多 2 次 */
function drawGuide(dirX: number, dirY: number) {
  const cue = cueBall();
  let ox = cue.x;
  let oy = cue.y;
  let dx = dirX;
  let dy = dirY;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,.75)";
  ctx.lineWidth = 1.6;
  ctx.setLineDash([7, 6]);
  for (let bounce = 0; bounce <= 2; bounce++) {
    // 最近的目标球碰撞（射线 vs 半径 2R 的圆）
    let ballT = Infinity;
    let hitBall: Ball | null = null;
    for (const ball of balls) {
      if (ball.cue || !ball.alive) continue;
      const cx = ball.x - ox;
      const cy = ball.y - oy;
      const proj = cx * dx + cy * dy;
      if (proj <= 0) continue;
      const d2 = cx * cx + cy * cy - proj * proj;
      const rr = BALL_R * 2 * BALL_R * 2;
      if (d2 >= rr) continue;
      const t = proj - Math.sqrt(rr - d2);
      if (t < ballT) { ballT = t; hitBall = ball; }
    }
    // 最近的库边
    let wallT = Infinity;
    let wallAxis: "x" | "y" = "x";
    if (dx > 0) { const t = (PLAY_W - BALL_R - ox) / dx; if (t > 0 && t < wallT) { wallT = t; wallAxis = "x"; } }
    if (dx < 0) { const t = (BALL_R - ox) / dx; if (t > 0 && t < wallT) { wallT = t; wallAxis = "x"; } }
    if (dy > 0) { const t = (PLAY_H - BALL_R - oy) / dy; if (t > 0 && t < wallT) { wallT = t; wallAxis = "y"; } }
    if (dy < 0) { const t = (BALL_R - oy) / dy; if (t > 0 && t < wallT) { wallT = t; wallAxis = "y"; } }

    if (hitBall && ballT < wallT) {
      const cx = ox + dx * ballT;
      const cy = oy + dy * ballT;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(cx, cy);
      ctx.stroke();
      // 接触点幻影球
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(cx, cy, BALL_R, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,.5)";
      ctx.stroke();
      // 目标球行进方向
      const tx = hitBall.x - cx;
      const ty = hitBall.y - cy;
      const len = Math.hypot(tx, ty) || 1;
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = "rgba(137,180,250,.9)";
      ctx.beginPath();
      ctx.moveTo(hitBall.x, hitBall.y);
      ctx.lineTo(hitBall.x + (tx / len) * 90, hitBall.y + (ty / len) * 90);
      ctx.stroke();
      break;
    }
    if (!Number.isFinite(wallT)) break;
    const wx = ox + dx * wallT;
    const wy = oy + dy * wallT;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(wx, wy);
    ctx.stroke();
    if (wallAxis === "x") dx = -dx; else dy = -dy;
    ox = wx;
    oy = wy;
  }
  ctx.restore();
}

/** 球杆：画在白球朝向光标的一侧（拉杆手位），杆头靠近白球，拖拽越远回拉越多 */
function drawCueStick(backX: number, backY: number, power: number) {
  const cue = cueBall();
  const pull = 14 + power * 90;
  const sx = cue.x + backX * (BALL_R + pull);
  const sy = cue.y + backY * (BALL_R + pull);
  const ex = cue.x + backX * (BALL_R + pull + 260);
  const ey = cue.y + backY * (BALL_R + pull + 260);
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = "#c89b6a";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  // 杆头（皮头）：贴白球的一端
  ctx.strokeStyle = "#89b4fa";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(sx + backX * 10, sy + backY * 10);
  ctx.stroke();
  ctx.restore();
}

function drawTable() {
  // 库边（木框）
  const rail = ctx.createLinearGradient(0, 0, 0, LOGIC_H);
  rail.addColorStop(0, "#6b4a2f");
  rail.addColorStop(0.5, "#5a3d26");
  rail.addColorStop(1, "#4a301e");
  ctx.fillStyle = rail;
  ctx.beginPath();
  ctx.roundRect(0, 0, LOGIC_W, LOGIC_H, 22);
  ctx.fill();
  // 台呢
  const felt = ctx.createRadialGradient(LOGIC_W / 2, LOGIC_H / 2, 60, LOGIC_W / 2, LOGIC_H / 2, LOGIC_W * 0.62);
  felt.addColorStop(0, "#2e8f5b");
  felt.addColorStop(1, "#1d6b41");
  ctx.fillStyle = felt;
  ctx.fillRect(RAIL, RAIL, PLAY_W, PLAY_H);
  // 袋口
  for (const p of POCKETS) {
    ctx.beginPath();
    ctx.arc(RAIL + p.x, RAIL + p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = "#0c0f0a";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(RAIL + p.x, RAIL + p.y, p.r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,0,0,.6)";
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

function draw() {
  ctx.clearRect(0, 0, LOGIC_W, LOGIC_H);
  drawTable();
  ctx.save();
  ctx.translate(RAIL, RAIL);
  const cue = cueBall();
  const canAim = aiming || (allStopped() && !gameOver && cue.alive);
  if (aiming && allStopped()) {
    const dx = aimX - cue.x;
    const dy = aimY - cue.y;
    const len = Math.hypot(dx, dy);
    if (len > 2) {
      // 拉杆式瞄准：光标在白球后方（球杆头部贴着光标一侧），球朝远离光标的方向击出
      const backX = dx / len;
      const backY = dy / len;
      const power = Math.min(1, len / MAX_DRAG);
      if (opts.guide) drawGuide(-backX, -backY);
      drawCueStick(backX, backY, power);
    }
  }
  for (const ball of balls) if (ball.alive) drawBall(ball);
  // 力度条
  if (aiming && allStopped()) {
    const dx = aimX - cue.x;
    const dy = aimY - cue.y;
    const power = Math.min(1, Math.hypot(dx, dy) / MAX_DRAG);
    const bw = 180;
    const bx = 16;
    const by = 16;
    ctx.fillStyle = "rgba(0,0,0,.4)";
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, 12, 6);
    ctx.fill();
    const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    grad.addColorStop(0, "#a6e3a1");
    grad.addColorStop(0.6, "#f9e2af");
    grad.addColorStop(1, "#f38ba8");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(bx + 2, by + 2, Math.max(0, (bw - 4) * power), 8, 4);
    ctx.fill();
  }
  ctx.restore();
  canvas.style.cursor = canAim ? "crosshair" : "default";
}

// ---------- 主循环 ----------
let lastTime = performance.now();
function tick(now: number) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  step(dt);
  draw();
  requestAnimationFrame(tick);
}

// ---------- 交互 ----------
function toPlayCoords(event: MouseEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  const scaleX = LOGIC_W / rect.width;
  return [
    (event.clientX - rect.left) * scaleX - RAIL,
    (event.clientY - rect.top) * (LOGIC_H / rect.height) - RAIL,
  ];
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !allStopped() || gameOver || !cueBall().alive) return;
  // 指针捕获：按住后即使光标拖出窗口，移动/松开事件仍持续派发到画布，瞄准与蓄力不会中断
  canvas.setPointerCapture(event.pointerId);
  aiming = true;
  [aimX, aimY] = toPlayCoords(event);
});
canvas.addEventListener("pointermove", (event) => {
  if (!aiming) return;
  [aimX, aimY] = toPlayCoords(event);
});
canvas.addEventListener("pointerup", (event) => {
  if (!aiming) return;
  aiming = false;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (!allStopped() || gameOver) return;
  const cue = cueBall();
  const dx = aimX - cue.x;
  const dy = aimY - cue.y;
  const len = Math.hypot(dx, dy);
  if (len < 8) return; // 视为误触
  const power = Math.min(1, len / MAX_DRAG);
  // 击球方向 = 白球指向远离光标的一侧
  cue.vx = (-dx / len) * power * MAX_SPEED;
  cue.vy = (-dy / len) * power * MAX_SPEED;
  shotCount++;
  wasMoving = true;
  updateHud();
});
// 指针被系统打断（如切窗、触摸取消）时结束本次瞄准，避免卡在瞄准态
canvas.addEventListener("pointercancel", () => { aiming = false; });
canvas.addEventListener("contextmenu", (event) => event.preventDefault());

// ---------- 选项与按钮 ----------
const optGuide = document.querySelector<HTMLInputElement>("#opt-guide")!;
const optIcons = document.querySelector<HTMLInputElement>("#opt-icons")!;
const optDuo = document.querySelector<HTMLInputElement>("#opt-duo")!;
const optCount = document.querySelector<HTMLSelectElement>("#opt-count")!;
optGuide.checked = opts.guide;
optIcons.checked = opts.icons;
optDuo.checked = opts.duo;
optCount.value = String(opts.count);

optGuide.onchange = () => { opts.guide = optGuide.checked; saveOptions(); };
optIcons.onchange = () => {
  opts.icons = optIcons.checked;
  saveOptions();
  void refreshIconsThenRack();
};
optDuo.onchange = () => { opts.duo = optDuo.checked; saveOptions(); newRack(); };
optCount.onchange = () => {
  const count = Number(optCount.value);
  opts.count = BALL_COUNTS.includes(count) ? count : DEFAULT_BALL_COUNT;
  saveOptions();
  newRack();
};
document.querySelector<HTMLButtonElement>("#new-game")!.onclick = () => void refreshIconsThenRack();
document.querySelector<HTMLButtonElement>("#banner-again")!.onclick = () => newRack();

/** 开启「启动列表图标」或点新开局时：重新拉取图标再摆球（无图标时保持默认台球样式） */
async function refreshIconsThenRack() {
  iconPool = opts.icons ? await fetchIconPool() : [];
  newRack();
}

window.addEventListener("resize", resize);

// ---------- 启动 ----------
loadConfig()
  .then((cfg) => { applyAppearance(cfg); applyWindowEffect(cfg.windowEffect); })
  .catch(() => {});
resize();
void refreshIconsThenRack();
requestAnimationFrame(tick);
