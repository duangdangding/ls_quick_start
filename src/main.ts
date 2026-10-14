import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as chooseFile } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { AppConfig, applyAppearance, applyWindowBackground, applyWindowEffect, loadConfig } from "./config";
import "./styles.css";

type Item = { id: string; name: string; target: string; groupId: string | null; isEncrypted: boolean; isCmd: boolean; iconPath: string | null; sortOrder: number; createdAt: number };
type Group = { id: string; name: string; sortOrder: number };
type DesktopEntry = { name: string; sourcePath: string; target: string; isShortcut: boolean; entryType: "shortcut" | "file" | "folder"; scanIconPath: string | null };
type SortBy = "custom" | "name" | "created";
type ImportResult = { added: number; skippedDuplicates: number; skippedInvalid: number };
type ItemIcon = { id: string; iconPath: string | null };

const encryptedId = "__encrypted__";
let items: Item[] = [];
let groups: Group[] = [];
let passwordSet = false;
let unlocked = false;
let activeGroup = "all";
let sortBy: SortBy = "custom";
let query = "";
let selected = 0;
let composingSearch = false;
let scanning: DesktopEntry[] = [];
let opening = false;
let searchSelection: [number, number] | null = null;
let pinned = false;

const app = document.querySelector<HTMLElement>("#app")!;
const escape = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const message = (value: unknown) => alert(typeof value === "string" ? value : "操作失败，请稍后重试");
const fixedGroups = () => [{ id: "all", name: "全部" }, { id: "none", name: "未分组" }, ...groups.sort((a, b) => a.sortOrder - b.sortOrder), { id: encryptedId, name: "加密" }];
const displayItems = () => {
  const needle = query.trim().toLowerCase();
  const groupItems = items.filter((item) => {
    if (activeGroup === encryptedId) return unlocked && item.isEncrypted;
    if (item.isEncrypted) return false;
    if (activeGroup === "none") return !item.groupId;
    return activeGroup === "all" || item.groupId === activeGroup;
  });
  const matched = groupItems.filter((item) => !needle || fuzzyScore(item, needle) > -1);
  return matched.sort((a, b) => sortBy === "name" ? a.name.localeCompare(b.name, "zh-CN") : sortBy === "created" ? b.createdAt - a.createdAt : a.sortOrder - b.sortOrder);
};
function fuzzyScore(item: Item, needle: string) {
  const full = (item as Item & { fullPinyin?: string }).fullPinyin ?? "";
  const initials = (item as Item & { initials?: string }).initials ?? "";
  const values = [item.name.toLowerCase(), full.toLowerCase(), initials.toLowerCase()];
  return Math.max(...values.map((value) => subsequenceScore(value, needle)));
}
function subsequenceScore(value: string, needle: string) {
  const exact = value.indexOf(needle); if (exact >= 0) return 200 - exact;
  let last = -1; let score = 0;
  for (const char of needle) { const next = value.indexOf(char, last + 1); if (next < 0) return -1; score += next === last + 1 ? 5 : 1; last = next; }
  return score;
}
/** 名称中的命中区间：优先连续子串，其次逐字符子序列（连续命中合并为一段） */
function nameMatchRanges(name: string, needle: string): [number, number][] | null {
  if (!needle) return null;
  const lower = name.toLowerCase();
  const exact = lower.indexOf(needle);
  if (exact >= 0) return [[exact, exact + needle.length]];
  const ranges: [number, number][] = [];
  let cursor = 0;
  for (const char of needle) {
    const next = lower.indexOf(char, cursor);
    if (next < 0) return null;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === next) last[1] = next + 1;
    else ranges.push([next, next + 1]);
    cursor = next + 1;
  }
  return ranges;
}
/** 渲染名称：把命中片段包进 <mark> 高亮；未命中（如拼音匹配）返回原文 */
function renderName(name: string, needle: string): string {
  const ranges = nameMatchRanges(name, needle);
  if (!ranges) return escape(name);
  let html = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) html += escape(name.slice(cursor, start));
    html += `<mark>${escape(name.slice(start, end))}</mark>`;
    cursor = Math.max(cursor, end);
  }
  if (cursor < name.length) html += escape(name.slice(cursor));
  return html;
}
async function load() {
  const data = await invoke<{ items: Item[]; groups: Group[]; passwordSet: boolean }>("list_data", { includeEncrypted: unlocked });
  const index = await invoke<{ id: string; fullPinyin: string; initials: string }[]>("searchable_items", { includeEncrypted: unlocked });
  const words = new Map(index.map((entry) => [entry.id, entry]));
  items = data.items.map((item) => Object.assign(item, words.get(item.id)));
  const icons = await invoke<ItemIcon[]>("item_icons");
  const iconMap = new Map(icons.map((icon) => [icon.id, icon.iconPath]));
  items.forEach((item) => { if (!item.iconPath) item.iconPath = iconMap.get(item.id) ?? null; });
  groups = data.groups; passwordSet = data.passwordSet;
  if (!fixedGroups().some((group) => group.id === activeGroup)) activeGroup = "all";
  render();
}
function itemIcon(item: Item) {
  if (item.iconPath) return `<img src="${escape(convertFileSrc(item.iconPath))}" alt="" />`;
  if (item.isCmd) return "⌘";
  if (/^https?:\/\//.test(item.target)) return "◎";
  if (/\.(exe|bat|cmd)$/i.test(item.target)) return "▣";
  if (/\\[^\\]+$/.test(item.target)) return "▰";
  return "▤";
}
function render() {
  const shown = displayItems(); selected = Math.max(0, Math.min(selected, Math.max(0, shown.length - 1)));
  app.innerHTML = `<section class="shell">
    <header><div class="brand">速启 <small>Quick Launch</small></div><label class="search"><span>⌕</span><input id="search" autofocus placeholder="搜索名称、拼音或首字母" value="${escape(query)}" /></label><button data-action="add" class="primary">＋ 添加</button><button data-action="scan">扫描桌面</button><button data-action="groups">管理</button><button data-action="settings" title="设置">⚙</button><button data-action="pin" title="钉住面板">${pinned ? "📌" : "📍"}</button></header>
    <nav id="tabs">${fixedGroups().map((group) => `<button class="tab ${group.id === activeGroup ? "active" : ""} ${group.id === encryptedId ? "lock" : ""}" data-group="${group.id}" draggable="${groups.some((normal) => normal.id === group.id)}">${group.id === encryptedId ? (unlocked ? "🔓" : "🔒") : ""}${escape(group.name)}</button>`).join("")}<button class="add-group" data-action="new-group" title="新建分组">＋</button></nav>
    <section class="toolbar"><span>${opening ? `<i class="loading-dot"></i>正在打开…` : activeGroup === encryptedId && !unlocked ? "加密分组已锁定" : `共 ${shown.length} 项`}</span><label>排序 <select id="sort"><option value="custom">自定义</option><option value="name">名称</option><option value="created">添加时间</option></select></label>${activeGroup === encryptedId ? `<button data-action="password">${unlocked ? "重置密码" : passwordSet ? "解锁" : "设置密码"}</button>` : ""}</section>
    <section id="grid" class="grid">${activeGroup === encryptedId && !unlocked ? `<div class="locked"><b>🔒 加密分组</b><p>解锁后才会显示其中的启动项，也不会参与全部搜索。</p><button class="primary" data-action="password">${passwordSet ? "输入密码解锁" : "设置访问密码"}</button></div>` : shown.length ? shown.map((item, index) => `<article class="card ${index === selected ? "selected" : ""}" data-id="${item.id}" draggable="${sortBy === "custom"}"><div class="icon">${itemIcon(item)}</div><div class="card-text"><b>${renderName(item.name, query.trim().toLowerCase())}</b><span>${escape(item.isCmd ? "CMD 命令" : item.target)}</span></div><button class="more" data-menu="${item.id}" title="更多">⋯</button></article>`).join("") : `<div class="empty"><b>这里还没有启动项</b><p>点击“添加”，或扫描桌面批量导入。</p></div>`}</section>
    <footer>右键空白处即可添加 · Enter 打开 · 方向键切换</footer>
  </section>`;
  const input = document.querySelector<HTMLInputElement>("#search")!;
  input.addEventListener("compositionstart", () => { composingSearch = true; });
  input.addEventListener("compositionend", () => { composingSearch = false; query = input.value; selected = 0; searchSelection = [input.selectionStart ?? query.length, input.selectionEnd ?? query.length]; render(); });
  input.addEventListener("input", () => { if (!composingSearch) { query = input.value; selected = 0; searchSelection = [input.selectionStart ?? query.length, input.selectionEnd ?? query.length]; render(); } });
  input.addEventListener("keydown", (event) => {
    if (composingSearch) return;
    const shownItems = displayItems();
    if (event.key === "Enter" && shownItems[selected]) { event.preventDefault(); void openItem(shownItems[selected].id); }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && shownItems.length) {
      event.preventDefault();
      const width = Math.max(1, Math.floor((document.querySelector("#grid")?.clientWidth ?? 250) / 220));
      const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -width : width;
      selected = (selected + delta + shownItems.length) % shownItems.length;
      render();
    }
  });
  input.focus();
  if (searchSelection) input.setSelectionRange(...searchSelection);
  document.querySelector<HTMLSelectElement>("#sort")!.value = sortBy;
  document.querySelector<HTMLSelectElement>("#sort")!.onchange = (event) => { sortBy = (event.target as HTMLSelectElement).value as SortBy; render(); };
  bindInteractions(shown);
}
function bindInteractions(shown: Item[]) {
  document.querySelectorAll<HTMLElement>("[data-action]").forEach((button) => button.onclick = () => void action(button.dataset.action!));
  document.querySelectorAll<HTMLElement>("[data-group]").forEach((tab) => { tab.onclick = () => { activeGroup = tab.dataset.group!; selected = 0; render(); }; tab.ondragstart = (event) => event.dataTransfer?.setData("group", tab.dataset.group!); tab.ondragover = (event) => event.preventDefault(); tab.ondrop = (event) => void reorderGroups(event, tab.dataset.group!); });
  document.querySelectorAll<HTMLElement>(".card").forEach((card) => { card.onclick = (event) => { if ((event.target as HTMLElement).closest(".more")) return; selected = shown.findIndex((item) => item.id === card.dataset.id); render(); }; card.ondblclick = () => void openItem(card.dataset.id!); card.ondragstart = (event) => event.dataTransfer?.setData("item", card.dataset.id!); card.ondragover = (event) => event.preventDefault(); card.ondrop = (event) => void reorderItems(event, card.dataset.id!); });
  document.querySelectorAll<HTMLElement>("[data-menu]").forEach((button) => button.onclick = (event) => { event.stopPropagation(); showItemMenu(button.dataset.menu!, button); });
  document.querySelector("#grid")?.addEventListener("contextmenu", (event) => { if ((event.target as HTMLElement).closest(".card")) return; event.preventDefault(); openItemDialog(); });
}
async function action(type: string) {
  if (type === "add") openItemDialog();
  if (type === "scan") await openScan();
  if (type === "groups") openGroupManager();
  if (type === "new-group") openGroupDialog();
  if (type === "password") openPasswordDialog();
  if (type === "settings") {
    await invoke("open_settings_window");
  }
  if (type === "pin") {
    pinned = !pinned;
    await invoke("set_panel_pinned", { pinned });
    render();
  }
}
async function openItem(id: string) {
  if (opening) return;
  opening = true; render();
  try { await invoke("open_item", { id, unlocked }); }
  catch (error) { message(error); }
  finally { opening = false; render(); }
}
function modal(content: string) { const node = document.createElement("div"); node.className = "overlay"; node.innerHTML = `<div class="modal">${content}</div>`; document.body.append(node); node.addEventListener("click", (event) => { if (event.target === node || (event.target as HTMLElement).dataset.close !== undefined) node.remove(); }); return node; }
function selectedGroup() { return activeGroup === "all" || activeGroup === "none" ? null : activeGroup; }
function openItemDialog(item?: Item) {
  const isCmd = item?.isCmd ?? false; const node = modal(`<h2>${item ? "编辑启动项" : "添加启动项"}</h2><form id="item-form"><label>名称<input name="name" required value="${escape(item?.name ?? "")}" placeholder="例如：工作资料" /></label><label>类型<select name="kind"><option value="target">文件、目录、快捷方式或 URL</option><option value="cmd">CMD 命令</option></select></label><label>启动目标<div class="with-button"><input name="target" required value="${escape(item?.target ?? "")}" placeholder="绝对路径、https:// 或命令" /><button type="button" id="pick">选择…</button></div></label><label>分组<select name="group"><option value="">未分组</option>${groups.sort((a,b) => a.sortOrder-b.sortOrder).map((group) => `<option value="${group.id}">${escape(group.name)}</option>`).join("")}<option value="${encryptedId}">🔒 加密</option></select></label><label>自定义图标（可选）<div class="with-button"><input name="icon" value="${escape(item?.iconPath ?? "")}" placeholder="图标文件路径" /><button type="button" id="pick-icon">选择…</button></div></label><div class="modal-actions"><button type="button" data-close>取消</button><button class="primary">保存</button></div></form>`); const form = node.querySelector<HTMLFormElement>("#item-form")!; const kind = form.elements.namedItem("kind") as HTMLSelectElement; kind.value = isCmd ? "cmd" : "target"; (form.elements.namedItem("group") as HTMLSelectElement).value = item?.groupId ?? selectedGroup() ?? "";
  node.querySelector<HTMLButtonElement>("#pick")!.onclick = async () => { const path = await chooseFile({ directory: false, multiple: false }); if (typeof path === "string") (form.elements.namedItem("target") as HTMLInputElement).value = path; };
  node.querySelector<HTMLButtonElement>("#pick-icon")!.onclick = async () => { const path = await chooseFile({ multiple: false, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "ico", "svg"] }] }); if (typeof path === "string") (form.elements.namedItem("icon") as HTMLInputElement).value = path; };
  form.onsubmit = async (event) => { event.preventDefault(); const values = new FormData(form); try { await invoke("save_item", { item: { id: item?.id ?? "", name: values.get("name"), target: values.get("target"), groupId: values.get("group") || null, isEncrypted: false, isCmd: kind.value === "cmd", iconPath: values.get("icon") || null, sortOrder: item?.sortOrder ?? 0, createdAt: item?.createdAt ?? 0 }, isCmd: kind.value === "cmd" }); node.remove(); await load(); } catch (error) { message(error); } };
}
function showItemMenu(id: string, anchor: HTMLElement) { document.querySelector(".menu")?.remove(); const menu = document.createElement("div"); menu.className = "menu"; menu.innerHTML = `<button data-edit>编辑</button><button data-open>打开</button><button class="danger" data-delete>删除</button>`; document.body.append(menu); const box = anchor.getBoundingClientRect(); menu.style.left = `${box.left - 100}px`; menu.style.top = `${box.bottom + 4}px`; menu.querySelector("[data-edit]")!.addEventListener("click", () => { menu.remove(); openItemDialog(items.find((item) => item.id === id)); }); menu.querySelector("[data-open]")!.addEventListener("click", () => { menu.remove(); void openItem(id); }); menu.querySelector("[data-delete]")!.addEventListener("click", async () => { if (!confirm("确认删除这个启动项？")) return; try { await invoke("delete_item", { id }); menu.remove(); await load(); } catch (error) { message(error); } }); }
function openGroupDialog(group?: Group) { const node = modal(`<h2>${group ? "重命名分组" : "新建分组"}</h2><form id="group-form"><label>分组名称<input name="name" required value="${escape(group?.name ?? "")}" /></label><div class="modal-actions"><button type="button" data-close>取消</button><button class="primary">保存</button></div></form>`); node.querySelector<HTMLFormElement>("#group-form")!.onsubmit = async (event) => { event.preventDefault(); const name = new FormData(event.currentTarget as HTMLFormElement).get("name"); try { if (group) await invoke("rename_group", { id: group.id, name }); else await invoke("create_group", { name }); node.remove(); await load(); } catch (error) { message(error); } }; }
function openGroupManager() { const node = modal(`<h2>分组管理</h2><div class="group-list">${groups.sort((a,b) => a.sortOrder-b.sortOrder).map((group) => `<div><span>${escape(group.name)}</span><button data-rename="${group.id}">重命名</button><button class="danger" data-delete-group="${group.id}">删除</button></div>`).join("") || "<p class=muted>尚未创建普通分组</p>"}</div><p class="hint">“全部”“未分组”“加密”为固定逻辑标签，不能删除。</p><div class="modal-actions"><button data-close>关闭</button><button class="primary" id="manager-add">新建分组</button></div>`); node.querySelector("#manager-add")!.addEventListener("click", () => { node.remove(); openGroupDialog(); }); node.querySelectorAll<HTMLElement>("[data-rename]").forEach((button) => button.onclick = () => { node.remove(); openGroupDialog(groups.find((group) => group.id === button.dataset.rename)); }); node.querySelectorAll<HTMLElement>("[data-delete-group]").forEach((button) => button.onclick = async () => { if (!confirm("删除分组后，组内项目会转为未分组。继续吗？")) return; try { await invoke("delete_group", { id: button.dataset.deleteGroup }); node.remove(); await load(); } catch (error) { message(error); } }); }
function openPasswordDialog() { const resetting = passwordSet && unlocked; const node = modal(`<h2>${resetting ? "重置加密密码" : passwordSet ? "解锁加密分组" : "设置加密密码"}</h2><form id="password-form">${resetting ? `<label>当前密码<input name="current" type="password" required /></label>` : ""}<label>${passwordSet && !resetting ? "密码" : "新密码"}<input name="password" type="password" minlength="4" required /></label><p class="hint">密码仅以随机 salt 的 SHA-256 哈希保存，无法找回。</p><div class="modal-actions"><button type="button" data-close>取消</button><button class="primary">确认</button></div></form>`); node.querySelector<HTMLFormElement>("#password-form")!.onsubmit = async (event) => { event.preventDefault(); const values = new FormData(event.currentTarget as HTMLFormElement); const password = String(values.get("password")); try { if (passwordSet && !resetting) { if (!await invoke<boolean>("unlock_encrypted", { password })) throw "密码不正确"; unlocked = true; } else { await invoke("reset_password", { currentPassword: values.get("current") || null, newPassword: password }); unlocked = true; } node.remove(); activeGroup = encryptedId; await load(); } catch (error) { message(error); } }; }
const scanMeta = (entry: DesktopEntry) => entry.entryType === "shortcut" ? { label: "快捷方式", icon: "↗" } : entry.entryType === "folder" ? { label: "文件夹", icon: "▰" } : { label: "文件", icon: "▤" };
function scanIcon(entry: DesktopEntry) { return entry.scanIconPath ? `<img src="${escape(convertFileSrc(entry.scanIconPath))}" alt="" />` : scanMeta(entry).icon; }
function updateScanSelection(node: HTMLElement) {
  const checked = node.querySelectorAll<HTMLInputElement>(".scan-list input:checked").length;
  const total = node.querySelectorAll<HTMLInputElement>(".scan-list input").length;
  const count = node.querySelector<HTMLElement>("#scan-count");
  if (count) count.textContent = `已选 ${checked} / ${total}`;
}
async function openScan() {
  try { scanning = await invoke<DesktopEntry[]>("scan_desktop"); } catch (error) { message(error); return; }
  const countByType = (type: DesktopEntry["entryType"]) => scanning.filter((entry) => entry.entryType === type).length;
  const node = modal(`<h2>扫描桌面</h2><p class="hint">已加速扫描：仅在导入所选快捷方式时解析真实目标。重复项会自动忽略。</p>
    <div class="scan-bulk"><span id="scan-count"></span><div><button type="button" data-select="shortcut">全选快捷方式 (${countByType("shortcut")})</button><button type="button" data-select="file">全选文件 (${countByType("file")})</button><button type="button" data-select="folder">全选文件夹 (${countByType("folder")})</button><button type="button" data-select="all">全选</button><button type="button" data-select="none">清空</button></div></div>
    <div class="scan-list">${scanning.map((entry, index) => { const meta = scanMeta(entry); return `<label><input type="checkbox" value="${index}" data-type="${entry.entryType}" ${entry.isShortcut ? "checked" : ""}/><span><i class="scan-icon ${entry.entryType}">${scanIcon(entry)}</i>${escape(entry.name)}<em>${meta.label}</em></span><small>${escape(entry.target)}</small></label>`; }).join("") || "<p class=muted>桌面没有可导入的文件或目录</p>"}</div>
    <div class="modal-actions"><button data-close>取消</button><button class="primary" id="import">导入已选</button></div>`);
  const toggle = (type: string) => {
    node.querySelectorAll<HTMLInputElement>(".scan-list input").forEach((input) => { input.checked = type === "all" ? true : type === "none" ? false : input.dataset.type === type; });
    updateScanSelection(node);
  };
  node.querySelectorAll<HTMLButtonElement>("[data-select]").forEach((button) => button.onclick = () => toggle(button.dataset.select!));
  node.querySelectorAll<HTMLInputElement>(".scan-list input").forEach((input) => input.onchange = () => updateScanSelection(node));
  updateScanSelection(node);
  node.querySelector("#import")?.addEventListener("click", async () => {
    const selectedEntries = [...node.querySelectorAll<HTMLInputElement>(".scan-list input:checked")].map((input) => scanning[Number(input.value)]);
    const button = node.querySelector<HTMLButtonElement>("#import")!;
    if (!selectedEntries.length) { message("请至少选择一项"); return; }
    button.disabled = true; button.innerHTML = `<i class="loading-dot"></i>正在导入…`;
    node.querySelectorAll<HTMLButtonElement>("button").forEach((control) => { if (control !== button) control.disabled = true; });
    try {
      const result = await invoke<ImportResult>("import_scanned", { entries: selectedEntries, groupId: selectedGroup() });
      node.remove(); await load();
      const skipped = result.skippedDuplicates + result.skippedInvalid;
      alert(`已导入 ${result.added} 项${skipped ? `；跳过重复 ${result.skippedDuplicates} 项、无效 ${result.skippedInvalid} 项。` : "。"}`);
    } catch (error) {
      button.disabled = false; button.textContent = "导入已选";
      node.querySelectorAll<HTMLButtonElement>("button").forEach((control) => control.disabled = false);
      message(error);
    }
  });
}
async function reorderItems(event: DragEvent, targetId: string) { event.preventDefault(); if (sortBy !== "custom") return; const sourceId = event.dataTransfer?.getData("item"); if (!sourceId || sourceId === targetId) return; const visible = displayItems(); const from = visible.findIndex((item) => item.id === sourceId); const to = visible.findIndex((item) => item.id === targetId); if (from < 0 || to < 0) return; visible.splice(to, 0, visible.splice(from, 1)[0]); try { await invoke("save_item_order", { ids: visible.map((item) => item.id) }); await load(); } catch (error) { message(error); } }
async function reorderGroups(event: DragEvent, targetId: string) { event.preventDefault(); const sourceId = event.dataTransfer?.getData("group"); if (!sourceId || sourceId === targetId) return; const reordered = groups.sort((a,b) => a.sortOrder-b.sortOrder); const from = reordered.findIndex((group) => group.id === sourceId); const to = reordered.findIndex((group) => group.id === targetId); if (from < 0 || to < 0) return; reordered.splice(to, 0, reordered.splice(from, 1)[0]); try { await invoke("save_group_order", { ids: reordered.map((group) => group.id) }); await load(); } catch (error) { message(error); } }
window.addEventListener("keydown", (event) => { const target = event.target as HTMLElement; if (target.matches("input, textarea, select")) { if (event.key === "Escape") document.querySelector<HTMLElement>(".overlay")?.remove(); return; } const shown = displayItems(); if (event.key === "Enter" && shown[selected]) { event.preventDefault(); void openItem(shown[selected].id); } if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && shown.length) { event.preventDefault(); const width = Math.max(1, Math.floor((document.querySelector("#grid")?.clientWidth ?? 250) / 220)); const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -width : width; selected = (selected + delta + shown.length) % shown.length; render(); } if (event.key === "Escape") document.querySelector<HTMLElement>(".overlay")?.remove(); });
void load();
// 应用外观配置（主题、高亮色、字号、窗口效果、面板背景）并监听设置页变更实时生效
loadConfig().then(async (cfg) => {
  applyAppearance(cfg);
  applyWindowEffect(cfg.windowEffect);
  await applyWindowBackground(cfg.background, true);
  pinned = cfg.alwaysOnTop;
  render();
});
listen<AppConfig>("config-changed", async (event) => {
  const cfg = event.payload;
  applyAppearance(cfg);
  applyWindowEffect(cfg.windowEffect);
  await applyWindowBackground(cfg.background, true);
  // 钉住状态可能来自托盘菜单，需实时反映到面板按钮
  if (cfg.alwaysOnTop !== pinned) {
    pinned = cfg.alwaysOnTop;
    render();
  }
});
