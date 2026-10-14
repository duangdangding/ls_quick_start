import { invoke } from "@tauri-apps/api/core";

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
  configDir: string;
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
}
