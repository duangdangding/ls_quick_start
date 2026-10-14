import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { AppConfig, BackgroundConfig, applyAppearance, applyWindowBackground, applyWindowEffect, defaultBackground, formatHotkey, loadConfig, saveConfig, styleBgLayer, DEFAULT_HOTKEY } from "./config";
import { check } from "@tauri-apps/plugin-updater";
import "./styles.css";

let config: AppConfig;
let recordingHotkey = false;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const markDirty = () => { $("#save-msg").textContent = "有未保存的修改"; };

// ---------- tab 切换 ----------
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-page").forEach((p) => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
  });
});

// ---------- 快捷键录制 ----------
const hotkeyBtn = $<HTMLButtonElement>("#hotkey");
function renderHotkey() { hotkeyBtn.textContent = formatHotkey(config.hotkey) || "点击录制"; }
hotkeyBtn.addEventListener("click", () => {
  recordingHotkey = true;
  hotkeyBtn.textContent = "请按下快捷键…";
});
hotkeyBtn.addEventListener("keydown", (e) => {
  if (!recordingHotkey) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") { recordingHotkey = false; renderHotkey(); return; }
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push(isMacLike() ? "Cmd" : "Win");
  let key = e.key;
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") return; // 等待更多键
  if (key === " ") key = "Space";
  if (key === "`" || key === "~") key = "`";
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  // 至少需要一个修饰键，避免抢占普通按键
  if (parts.length < 2) return;
  config.hotkey = parts.join("+");
  recordingHotkey = false;
  renderHotkey();
  markDirty();
});
function isMacLike() { return navigator.platform.toUpperCase().includes("MAC"); }

$("#hotkey-reset").addEventListener("click", () => { config.hotkey = DEFAULT_HOTKEY; renderHotkey(); markDirty(); });

// ---------- 常规 ----------
function bindCheck(id: string, key: keyof AppConfig) {
  const el = $(`#${id}`) as HTMLInputElement;
  el.checked = Boolean(config[key]);
  el.addEventListener("change", () => { (config as unknown as Record<string, unknown>)[key] = el.checked; markDirty(); });
}

// ---------- 加密分组解锁 ----------
const encryptUnlockSel = $<HTMLSelectElement>("#encrypt-unlock-mode");
encryptUnlockSel.addEventListener("change", () => { config.encryptUnlockMode = encryptUnlockSel.value; markDirty(); });

// ---------- 外观 ----------
const themeSel = $<HTMLSelectElement>("#theme");
const colorInput = $<HTMLInputElement>("#highlight-color");
const followThemeInput = $<HTMLInputElement>("#highlight-follow");
const fontSizeInput = $<HTMLInputElement>("#font-size");
const effectSel = $<HTMLSelectElement>("#window-effect");

themeSel.addEventListener("change", () => { config.theme = themeSel.value; markDirty(); });
// 高亮颜色：空 = 跟随主题强调色（勾选框勾上、取色器禁用但保留上次颜色）
function syncHighlightUI() {
  const follow = followThemeInput.checked;
  colorInput.disabled = follow;
  config.highlightColor = follow ? "" : colorInput.value;
}
followThemeInput.addEventListener("change", () => { syncHighlightUI(); markDirty(); });
colorInput.addEventListener("input", () => { followThemeInput.checked = false; syncHighlightUI(); markDirty(); });
fontSizeInput.addEventListener("change", () => { config.fontSize = Number(fontSizeInput.value) || 14; markDirty(); });
effectSel.addEventListener("change", async () => {
  config.windowEffect = effectSel.value;
  // 实时预览
  try { await invoke("set_window_effect", { effect: config.windowEffect }); } catch { /* 保存时还会再应用 */ }
  await invoke("show_panel");
  markDirty();
});

// ---------- 配置文件目录 ----------
async function refreshConfigDir() { $("#config-dir").textContent = await invoke<string>("get_config_dir"); }

$("#btn-change-config-dir").addEventListener("click", async () => {
  const path = await openDialog({ directory: true, title: "选择配置文件目录" });
  if (!path || typeof path !== "string") return;
  const action = confirm("是否将现有配置文件移动到新目录？\n确定=移动文件，取消=仅修改路径") ? "move" : "keep";
  await invoke("set_data_dirs", { configDir: path, dbDir: null, action });
  await refreshConfigDir();
  alert("配置目录已更改，重启应用后生效");
});

$("#btn-reset-config-dir").addEventListener("click", async () => {
  if (!confirm("确定恢复默认配置目录（程序目录）？")) return;
  await invoke("set_data_dirs", { configDir: null, dbDir: null, action: "reset" });
  await refreshConfigDir();
  alert("配置目录已恢复默认，重启应用后生效");
});

// ---------- 数据库 ----------
async function refreshDbDir() { $("#db-dir").textContent = await invoke<string>("get_db_dir"); }

$("#btn-change-db-dir").addEventListener("click", async () => {
  const path = await openDialog({ directory: true, title: "选择数据库目录" });
  if (!path || typeof path !== "string") return;
  const action = confirm("是否将现有数据库文件移动到新目录？\n确定=移动文件，取消=仅修改路径") ? "move" : "keep";
  await invoke("set_data_dirs", { configDir: null, dbDir: path, action });
  await refreshDbDir();
  await refreshDbInfo();
  alert("数据库目录已更改，重启应用后生效");
});

$("#btn-reset-db-dir").addEventListener("click", async () => {
  if (!confirm("确定恢复默认数据库目录（程序目录）？")) return;
  await invoke("set_data_dirs", { configDir: null, dbDir: null, action: "reset" });
  await refreshDbDir();
  await refreshDbInfo();
  alert("数据库目录已恢复默认，重启应用后生效");
});

async function refreshDbInfo() {
  const info = await invoke<{ path: string; size: number; itemCount: number; groupCount: number; passwordSet: boolean }>("get_db_info");
  $("#db-path").textContent = info.path;
  $("#db-size").textContent = `${(info.size / 1024).toFixed(1)} KB`;
  $("#db-items").textContent = String(info.itemCount);
  $("#db-groups").textContent = String(info.groupCount);
  $("#db-password").textContent = info.passwordSet ? "是" : "否";
}

// ---------- 面板背景 ----------
const bgEnabledEl = $<HTMLInputElement>("#bg-enabled");
const bgPickBtn = $<HTMLButtonElement>("#bg-pick");
const bgClearBtn = $<HTMLButtonElement>("#bg-clear");
const bgApplySettingsEl = $<HTMLInputElement>("#bg-apply-settings");
const bgEditorEl = $<HTMLDivElement>("#bg-editor");
const bgPreviewLayerEl = $<HTMLDivElement>("#bg-preview-layer");
const bgModeEl = $<HTMLSelectElement>("#bg-mode");
const bgOpacityEl = $<HTMLInputElement>("#bg-opacity");
const bgOpacityValEl = $<HTMLSpanElement>("#bg-opacity-val");
const bgScaleWEl = $<HTMLInputElement>("#bg-scale-w");
const bgScaleWValEl = $<HTMLSpanElement>("#bg-scale-w-val");
const bgScaleHEl = $<HTMLInputElement>("#bg-scale-h");
const bgScaleHValEl = $<HTMLSpanElement>("#bg-scale-h-val");
const bgRegionToggleBtn = $<HTMLButtonElement>("#bg-region-toggle");
const bgRegionResetBtn = $<HTMLButtonElement>("#bg-region-reset");
const bgRegionWrapEl = $<HTMLDivElement>("#bg-region-wrap");
const bgRegionBoxEl = $<HTMLDivElement>("#bg-region-box");
const bgRegionImgEl = $<HTMLImageElement>("#bg-region-img");
const bgRegionRectEl = $<HTMLDivElement>("#bg-region-rect");
const bgApplyBtn = $<HTMLButtonElement>("#bg-apply");

let bgDraft: BackgroundConfig = defaultBackground(); // 编辑中的选项（点「应用背景」才落盘）
let bgSrcImg: HTMLImageElement | null = null; // 源图（原始方向）
let bgPreviewB64: string | null = null; // 预览烘焙缓存（旋转/选区/换图才重烘）

/** 烘焙背景图：旋转 → 按选区裁剪 → 限制最大边长，输出 canvas */
function bakeBackground(maxDim: number): HTMLCanvasElement | null {
  const img = bgSrcImg;
  if (!img) return null;
  const rot = ((bgDraft.rotation % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const rw = swap ? img.naturalHeight : img.naturalWidth;
  const rh = swap ? img.naturalWidth : img.naturalHeight;
  // 先旋转到正向画布
  const rotC = document.createElement("canvas");
  rotC.width = rw;
  rotC.height = rh;
  const rctx = rotC.getContext("2d")!;
  rctx.translate(rw / 2, rh / 2);
  rctx.rotate((rot * Math.PI) / 180);
  rctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  // 选区是归一化坐标，基于旋转后的图
  const rg = bgDraft.region;
  const sx = rg ? rg.x * rw : 0;
  const sy = rg ? rg.y * rh : 0;
  const sw = rg ? rg.w * rw : rw;
  const sh = rg ? rg.h * rh : rh;
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(sw * scale));
  out.height = Math.max(1, Math.round(sh * scale));
  out.getContext("2d")!.drawImage(rotC, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

function rebakeBgPreview() {
  const c = bakeBackground(1600);
  bgPreviewB64 = c ? c.toDataURL("image/png").split(",")[1] : null;
  applyBgPreviewStyle();
}

function applyBgPreviewStyle() {
  if (bgPreviewB64) styleBgLayer(bgPreviewLayerEl, bgDraft, bgPreviewB64);
  applyBgDraftToSelfWindow();
}

/** 草稿实时应用到设置窗口自身（勾选「同时应用到设置窗口」时整窗可见） */
function applyBgDraftToSelfWindow() {
  applyWindowBackground(bgDraft, bgDraft.applySettings, bgPreviewB64 ?? undefined);
}

/** 选区编辑器里的图片：旋转后的整图（不含选区裁剪） */
function refreshRotatedSource() {
  if (!bgSrcImg) return;
  const keep = bgDraft.region;
  bgDraft.region = null;
  const c = bakeBackground(800);
  bgDraft.region = keep;
  if (c) bgRegionImgEl.src = c.toDataURL("image/png");
}

/** 把 draft.region 画成选区框（百分比定位，随图片缩放自适应） */
function renderRegionRect() {
  const rg = bgDraft.region;
  if (!rg || rg.w <= 0 || rg.h <= 0) {
    bgRegionRectEl.style.display = "none";
    return;
  }
  bgRegionRectEl.style.display = "block";
  bgRegionRectEl.style.left = `${rg.x * 100}%`;
  bgRegionRectEl.style.top = `${rg.y * 100}%`;
  bgRegionRectEl.style.width = `${rg.w * 100}%`;
  bgRegionRectEl.style.height = `${rg.h * 100}%`;
}

/** 控件 ↔ bgDraft 同步（控件侧） */
function syncBgControls() {
  bgEnabledEl.checked = bgDraft.enabled;
  bgApplySettingsEl.checked = bgDraft.applySettings;
  bgModeEl.value = bgDraft.mode === "tile" ? "tile" : "stretch";
  const pct = Math.round(Math.max(0.05, Math.min(1, bgDraft.opacity)) * 100);
  bgOpacityEl.value = String(pct);
  bgOpacityValEl.textContent = `${pct}%`;
  const clampScale = (v: number) => Math.round(Math.max(5, Math.min(300, v || 100)));
  bgScaleWEl.value = String(clampScale(bgDraft.scaleW));
  bgScaleWValEl.textContent = `${bgScaleWEl.value}%`;
  bgScaleHEl.value = String(clampScale(bgDraft.scaleH));
  bgScaleHValEl.textContent = `${bgScaleHEl.value}%`;
  document.querySelectorAll<HTMLButtonElement>(".bg-rot").forEach((b) =>
    b.classList.toggle("active", Number(b.dataset.rot) === bgDraft.rotation)
  );
  bgClearBtn.disabled = !bgDraft.hasImage;
  bgEditorEl.hidden = !bgDraft.hasImage;
  bgRegionResetBtn.disabled = !bgDraft.region;
  renderRegionRect();
}

async function loadBgSource(): Promise<boolean> {
  const data = await invoke<{ b64: string; mime: string } | null>("read_background_source");
  if (!data) {
    bgSrcImg = null;
    return false;
  }
  const img = new Image();
  img.src = `data:${data.mime};base64,${data.b64}`;
  await img.decode();
  bgSrcImg = img;
  return true;
}

bgEnabledEl.addEventListener("change", async () => {
  bgDraft.enabled = bgEnabledEl.checked;
  applyBgDraftToSelfWindow();
  // 启用/关闭即时落盘并广播 config-changed：主面板实时跟随，无需点「应用背景」
  try {
    const bg: BackgroundConfig = { ...(config.background || defaultBackground()), enabled: bgEnabledEl.checked };
    await invoke("set_background_config", { bg });
    config.background = bg;
    await invoke("show_panel");
  } catch (e) {
    alert(`切换背景开关失败: ${e}`);
  }
});

// 应用范围开关：设置窗口立即整窗预览
bgApplySettingsEl.addEventListener("change", () => {
  bgDraft.applySettings = bgApplySettingsEl.checked;
  applyBgDraftToSelfWindow();
});

bgPickBtn.addEventListener("click", async () => {
  const path = await openDialog({
    title: "选择背景图片",
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }],
  });
  if (typeof path !== "string") return;
  try {
    await invoke("import_background_source", { path });
    await loadBgSource();
    // 换图后回到正向整图，保留填充方式/透明度偏好
    bgDraft = { ...bgDraft, enabled: true, hasImage: true, rotation: 0, region: null };
    refreshRotatedSource();
    syncBgControls();
    rebakeBgPreview();
  } catch (e) {
    alert(`选择背景图失败: ${e}`);
  }
});

bgClearBtn.addEventListener("click", async () => {
  if (!confirm("确定清除面板背景图？")) return;
  try {
    await invoke("clear_background_image");
    bgDraft = defaultBackground();
    bgSrcImg = null;
    bgPreviewB64 = null;
    bgPreviewLayerEl.style.backgroundImage = "none";
    bgRegionWrapEl.hidden = true;
    config.background = bgDraft;
    syncBgControls();
    applyBgDraftToSelfWindow();
  } catch (e) {
    alert(`清除背景失败: ${e}`);
  }
});

bgModeEl.addEventListener("change", () => {
  bgDraft.mode = bgModeEl.value;
  applyBgPreviewStyle();
});

bgOpacityEl.addEventListener("input", () => {
  bgDraft.opacity = Number(bgOpacityEl.value) / 100;
  bgOpacityValEl.textContent = `${bgOpacityEl.value}%`;
  applyBgPreviewStyle();
});

// 宽高百分比：纯 CSS background-size 调整，无需重烘焙
bgScaleWEl.addEventListener("input", () => {
  bgDraft.scaleW = Number(bgScaleWEl.value);
  bgScaleWValEl.textContent = `${bgScaleWEl.value}%`;
  applyBgPreviewStyle();
});
bgScaleHEl.addEventListener("input", () => {
  bgDraft.scaleH = Number(bgScaleHEl.value);
  bgScaleHValEl.textContent = `${bgScaleHEl.value}%`;
  applyBgPreviewStyle();
});

// 旋转：选区是相对旋转后图的，旋转变化后旧选区失效，重置为整图
document.querySelectorAll<HTMLButtonElement>(".bg-rot").forEach((btn) => {
  btn.addEventListener("click", () => {
    const rot = Number(btn.dataset.rot) || 0;
    if (rot === bgDraft.rotation) return;
    bgDraft.rotation = rot;
    bgDraft.region = null;
    refreshRotatedSource();
    syncBgControls();
    rebakeBgPreview();
  });
});

bgRegionToggleBtn.addEventListener("click", () => {
  bgRegionWrapEl.hidden = !bgRegionWrapEl.hidden;
  if (!bgRegionWrapEl.hidden) refreshRotatedSource();
});

bgRegionResetBtn.addEventListener("click", () => {
  bgDraft.region = null;
  syncBgControls();
  rebakeBgPreview();
});

// 选区框选：在（旋转后的）源图上按住拖动出矩形，归一化存储
let bgDragging = false;
let bgDragStart = { x: 0, y: 0 };

function bgRelPos(e: MouseEvent) {
  const r = bgRegionImgEl.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
    y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
  };
}

bgRegionBoxEl.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || !bgSrcImg) return;
  e.preventDefault();
  bgDragging = true;
  bgDragStart = bgRelPos(e);
  bgDraft.region = { x: bgDragStart.x, y: bgDragStart.y, w: 0, h: 0 };
  renderRegionRect();
});
window.addEventListener("mousemove", (e) => {
  if (!bgDragging) return;
  const p = bgRelPos(e);
  bgDraft.region = {
    x: Math.min(bgDragStart.x, p.x),
    y: Math.min(bgDragStart.y, p.y),
    w: Math.abs(p.x - bgDragStart.x),
    h: Math.abs(p.y - bgDragStart.y),
  };
  renderRegionRect();
});
window.addEventListener("mouseup", () => {
  if (!bgDragging) return;
  bgDragging = false;
  // 太小的框按误触处理：恢复整图
  if (bgDraft.region && (bgDraft.region.w < 0.03 || bgDraft.region.h < 0.03)) {
    bgDraft.region = null;
  }
  syncBgControls();
  rebakeBgPreview();
});

// 应用：烘焙成品图（≤1600px）存到配置目录，设置落盘并弹出主面板看实际效果
bgApplyBtn.addEventListener("click", async () => {
  const c = bakeBackground(1600);
  if (!c) {
    alert("请先选择图片");
    return;
  }
  bgApplyBtn.disabled = true;
  try {
    const b64 = c.toDataURL("image/png").split(",")[1];
    await invoke("save_background_cache", { b64 });
    const bg: BackgroundConfig = { ...bgDraft, hasImage: true };
    await invoke("set_background_config", { bg });
    config.background = bg;
    bgDraft = { ...bg, region: bg.region ? { ...bg.region } : null };
    syncBgControls();
    await invoke("show_panel");
  } catch (e) {
    alert(`应用背景失败: ${e}`);
  } finally {
    bgApplyBtn.disabled = false;
  }
});

// 初始化：回填已保存的背景设置；源图还在则重建预览
async function initBackground() {
  const saved = config.background || defaultBackground();
  bgDraft = { ...defaultBackground(), ...saved, region: saved.region ? { ...saved.region } : null };
  if (bgDraft.hasImage) {
    if (await loadBgSource()) {
      refreshRotatedSource();
      rebakeBgPreview();
    } else {
      // 源图丢失（如配置目录被换过）：按无图处理，等用户重新选择
      bgDraft.hasImage = false;
    }
  }
  syncBgControls();
  // 设置窗口自身的背景（按已保存设置的 applySettings 决定）
  applyBgDraftToSelfWindow();
}

// ---------- 更新 ----------
async function checkUpdate() {
  const btn = $<HTMLButtonElement>("#btn-check-update");
  const infoEl = $("#update-version-info");
  const wrap = $("#update-progress-wrap");
  btn.disabled = true;
  infoEl.textContent = "正在检查…";
  wrap.style.display = "none";
  try {
    const update = await check();
    if (!update) { infoEl.textContent = "已是最新版本"; return; }
    infoEl.textContent = `发现新版本 v${update.version}`;
    if (!confirm(`发现新版本 v${update.version}，是否下载并安装？`)) { infoEl.textContent = ""; return; }

    const isPortable = !window.location.href.includes("nsis");
    const release = (update as unknown as { rawJson?: { assets?: { name: string; browser_download_url: string }[] } }).rawJson;
    const assets = release?.assets ?? [];
    const portableAsset = assets.find((a) => a.name.includes("portable") && a.name.endsWith(".exe"));
    const nsisAsset = assets.find((a) => a.name.endsWith(".exe") && !a.name.includes("portable"));

    if (isPortable && portableAsset) {
      await doPortableUpdate(portableAsset.browser_download_url, portableAsset.name, infoEl, wrap);
    } else if (!isPortable && nsisAsset) {
      await doInstallerUpdate(nsisAsset.browser_download_url, nsisAsset.name, infoEl, wrap);
    } else {
      infoEl.textContent = "未找到合适的更新文件";
    }
  } catch (e) {
    infoEl.textContent = `检查更新失败：${e}`;
  } finally {
    btn.disabled = false;
  }
}

async function downloadWithProgress(url: string, dest: string): Promise<void> {
  const progressEl = $<HTMLProgressElement>("#update-progress");
  const textEl = $("#update-progress-text");
  const unlisten = await listen<{ downloaded: number; total: number }>("update-download-progress", (e) => {
    const pct = e.payload.total > 0 ? Math.round((e.payload.downloaded / e.payload.total) * 100) : 0;
    progressEl.value = pct;
    textEl.textContent = `${pct}%`;
  });
  try {
    await invoke("portable_update_download", { url, dest });
  } finally {
    unlisten();
  }
}

async function fetchSha256(url: string, fileName: string): Promise<string | null> {
  try {
    const text = await invoke<string>("http_get_text", { url });
    for (const line of text.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1].trim() === fileName) return parts[0].trim();
    }
  } catch { /* 无校验文件 */ }
  return null;
}

async function doPortableUpdate(url: string, fileName: string, infoEl: HTMLElement, wrap: HTMLElement) {
  wrap.style.display = "block";
  infoEl.textContent = "正在下载更新…";
  const [exePath, tempDir] = await invoke<[string, string]>("get_update_paths");
  const dest = `${tempDir}\\${fileName}`;
  await downloadWithProgress(url, dest);

  infoEl.textContent = "正在校验文件…";
  const sha256Url = url.substring(0, url.lastIndexOf("/") + 1) + "sha256sums.txt";
  const expected = await fetchSha256(sha256Url, fileName);
  if (expected) {
    const ok = await invoke<boolean>("portable_update_verify", { filePath: dest, expectedSha256: expected });
    if (!ok) { infoEl.textContent = "校验失败，已中止更新"; return; }
  }

  infoEl.textContent = "正在安装更新…";
  await invoke("portable_update_apply", { exePath, newFile: dest });
}

async function doInstallerUpdate(url: string, fileName: string, infoEl: HTMLElement, wrap: HTMLElement) {
  wrap.style.display = "block";
  infoEl.textContent = "正在下载安装包…";
  const [, tempDir] = await invoke<[string, string]>("get_update_paths");
  const dest = `${tempDir}\\${fileName}`;
  await downloadWithProgress(url, dest);

  infoEl.textContent = "正在校验文件…";
  const sha256Url = url.substring(0, url.lastIndexOf("/") + 1) + "sha256sums.txt";
  const expected = await fetchSha256(sha256Url, fileName);
  if (expected) {
    const ok = await invoke<boolean>("portable_update_verify", { filePath: dest, expectedSha256: expected });
    if (!ok) { infoEl.textContent = "SHA-256 校验不一致，文件可能损坏，请重试"; return; }
  }

  infoEl.textContent = "即将启动安装程序…";
  if (confirm("下载完成，是否立即运行安装程序？")) {
    await invoke("installer_update_run", { path: dest });
  }
}

$("#btn-check-update").addEventListener("click", checkUpdate);

// ---------- 保存 ----------
$("#btn-save").addEventListener("click", async () => {
  try {
    // 若选了背景图但没点「应用背景」，保存时一并烘焙落盘，避免“保存后主面板无效果”
    if (bgDraft.hasImage && bgSrcImg) {
      const c = bakeBackground(1600);
      if (c) {
        const b64 = c.toDataURL("image/png").split(",")[1];
        await invoke("save_background_cache", { b64 });
        const bg: BackgroundConfig = { ...bgDraft, hasImage: true };
        await invoke("set_background_config", { bg });
        config.background = bg;
        bgDraft = { ...bg, region: bg.region ? { ...bg.region } : null };
      }
    }
    await saveConfig(config);
    $("#save-msg").textContent = "已保存";
    setTimeout(() => { $("#save-msg").textContent = ""; }, 2000);
    refreshConfigDir();
  } catch (e) {
    alert(String(e));
  }
});

// ---------- 初始化 ----------
(async () => {
  config = await loadConfig();

  bindCheck("autostart", "autostart");
  bindCheck("silent-start", "silentStart");
  bindCheck("always-on-top", "alwaysOnTop");
  bindCheck("remember-size", "rememberSize");

  encryptUnlockSel.value = config.encryptUnlockMode === "always" ? "always" : "session";

  themeSel.value = config.theme;
  // 搜索高亮颜色：空 = 跟随主题强调色（勾选框勾上、取色器禁用但保留上次颜色）
  const hl = (config.highlightColor || "").trim();
  followThemeInput.checked = !hl;
  colorInput.value = /^#[0-9a-fA-F]{6}$/.test(hl) ? hl : "#7c3aed";
  colorInput.disabled = !hl;
  fontSizeInput.value = String(config.fontSize);
  effectSel.value = config.windowEffect;

  renderHotkey();
  refreshConfigDir();
  refreshDbDir();
  refreshDbInfo();
  applyAppearance(config);
  applyWindowEffect(config.windowEffect);
  initBackground().catch(() => { /* 背景源图读取失败不影响设置页其余功能 */ });

  // ---------- 关于 ----------
  getVersion().then((v) => { $("#cur-version").textContent = v; });
})();
