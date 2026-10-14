import { invoke } from "@tauri-apps/api/core";

export interface BackgroundConfig {
  enabled: boolean;
  opacity: number;
  imageData?: string;
}

export interface AppConfig {
  hotkey: string;
  autostart: boolean;
  silentStart: boolean;
  alwaysOnTop: boolean;
  rememberSize: boolean;
  windowWidth: number;
  windowHeight: number;
  theme: string;
  fontFamily: string;
  fontSize: number;
  highlightColor: string;
  windowEffect: string;
  configDir?: string;
  dbDir?: string;
  background: BackgroundConfig;
}

export const DEFAULT_HOTKEY = "Win+`";
export const isMac = navigator.platform.toUpperCase().includes("MAC");

export async function loadConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_config");
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await invoke("save_config", { config });
}

/** 把配置里的快捷键格式化成展示文本（mac 用符号） */
export function formatHotkey(hotkey: string): string {
  if (!isMac) return hotkey;
  return hotkey
    .replace(/Ctrl\+/gi, "\u2303")
    .replace(/Shift\+/gi, "\u21E7")
    .replace(/Alt\+/gi, "\u2325")
    .replace(/Win\+|Super\+|Meta\+|Cmd\+/gi, "\u2318");
}

/** 应用外观（主题、高亮色、字号、字体）到文档根 */
export function applyAppearance(config: AppConfig): void {
  const root = document.documentElement;
  root.dataset.theme = config.theme;
  root.dataset.effect = config.windowEffect;
  root.style.setProperty("--hl-color", config.highlightColor);
  root.style.fontFamily = config.fontFamily || "system-ui";
  root.style.fontSize = `${config.fontSize || 14}px`;
  applyBackground(config.background);
}

/** 应用自定义背景层 */
export function applyBackground(bg: BackgroundConfig): void {
  const root = document.documentElement;
  let layer = document.querySelector<HTMLDivElement>(".bg-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "bg-layer";
    document.body.prepend(layer);
  }
  if (bg.enabled && bg.imageData) {
    layer.style.backgroundImage = `url(data:image/png;base64,${bg.imageData})`;
    layer.style.opacity = String(bg.opacity ?? 0.5);
    layer.style.display = "block";
    root.dataset.bg = "on";
  } else {
    layer.style.display = "none";
    root.dataset.bg = "off";
  }
}
