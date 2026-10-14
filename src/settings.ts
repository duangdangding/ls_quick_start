import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { AppConfig, DEFAULT_HOTKEY, formatHotkey, loadConfig, saveConfig } from "./config";
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

// ---------- 数据库 ----------
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
  refreshDbInfo();

  // ---------- 关于 ----------
  getVersion().then((v) => { $("#cur-version").textContent = v; });
})();
