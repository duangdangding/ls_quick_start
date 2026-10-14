import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { AppConfig, applyAppearance, DEFAULT_HOTKEY, formatHotkey, loadConfig, saveConfig } from "./config";
import { check } from "@tauri-apps/plugin-updater";
import { readFile } from "@tauri-apps/plugin-fs";
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

// ---------- 外观 ----------
const themeSel = $<HTMLSelectElement>("#theme");
const colorInput = $<HTMLInputElement>("#highlight-color");
const fontSizeInput = $<HTMLInputElement>("#font-size");
const effectSel = $<HTMLSelectElement>("#window-effect");

themeSel.addEventListener("change", () => { config.theme = themeSel.value; markDirty(); });
colorInput.addEventListener("input", () => { config.highlightColor = colorInput.value; markDirty(); });
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

$("#btn-export").addEventListener("click", async () => {
  const json = await invoke<string>("export_data");
  const path = await saveDialog({ defaultPath: "suqi-backup.json", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!path) return;
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  await writeTextFile(path, json);
});

$("#btn-import").addEventListener("click", async () => {
  const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
  const path = await openDialog({ filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!path || typeof path !== "string") return;
  const { readTextFile } = await import("@tauri-apps/plugin-fs");
  const json = await readTextFile(path);
  if (!confirm("导入将覆盖当前全部数据，确定继续？")) return;
  await invoke("import_data", { json });
  alert("导入成功，重启应用后生效");
});

// ---------- 自定义背景 ----------
const bgEnabled = $<HTMLInputElement>("#bg-enabled");
const bgOpacity = $<HTMLInputElement>("#bg-opacity");
const bgPreviewRow = $<HTMLDivElement>("#bg-preview-row");
const bgPreview = $<HTMLImageElement>("#bg-preview");

function syncBgUI() {
  bgEnabled.checked = config.background?.enabled ?? false;
  bgOpacity.value = String(config.background?.opacity ?? 0.5);
  const hasImg = Boolean(config.background?.imageData);
  bgPreviewRow.style.display = hasImg ? "flex" : "none";
  if (hasImg) bgPreview.src = `data:image/png;base64,${config.background!.imageData!}`;
}

bgEnabled.addEventListener("change", () => { config.background.enabled = bgEnabled.checked; markDirty(); });
bgOpacity.addEventListener("input", () => { config.background.opacity = Number(bgOpacity.value); markDirty(); });

$("#btn-bg-import").addEventListener("click", async () => {
  const path = await openDialog({ filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }] });
  if (!path || typeof path !== "string") return;
  const data = await readFile(path);
  if (data.length > 30 * 1024 * 1024) { alert("图片不能超过 30MB"); return; }
  let base64 = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < data.length; i += CHUNK) {
    base64 += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  config.background.imageData = btoa(base64);
  config.background.enabled = true;
  syncBgUI();
  markDirty();
});

$("#btn-bg-clear").addEventListener("click", () => {
  config.background = { enabled: false, opacity: 0.5, imageData: undefined };
  syncBgUI();
  markDirty();
});

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

  themeSel.value = config.theme;
  colorInput.value = config.highlightColor;
  fontSizeInput.value = String(config.fontSize);
  effectSel.value = config.windowEffect;

  renderHotkey();
  refreshConfigDir();
  refreshDbDir();
  refreshDbInfo();
  syncBgUI();
  applyAppearance(config);

  // ---------- 关于 ----------
  getVersion().then((v) => { $("#cur-version").textContent = v; $("#about-version").textContent = v; });
})();
