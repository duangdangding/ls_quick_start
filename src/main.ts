import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as chooseFile } from "@tauri-apps/plugin-dialog";
import { emit, listen } from "@tauri-apps/api/event";
import { AppConfig, applyAppearance, applyWindowBackground, applyWindowEffect, isMac, loadConfig, saveConfig } from "./config";
import { autoCheckEnabled, checkUpdate } from "./updater";
import "./styles.css";

type Item = { id: string; name: string; keyword: string; target: string; groupId: string | null; isEncrypted: boolean; isCmd: boolean; iconPath: string | null; sortOrder: number; createdAt: number };
type Group = { id: string; name: string; sortOrder: number };
type DesktopEntry = { name: string; sourcePath: string; target: string; isShortcut: boolean; entryType: "shortcut" | "file" | "folder"; scanIconPath: string | null; folderName: string | null; relPath: string[] };
type SortBy = "relevance" | "name" | "created" | "type";
type ScanSource = { kind: "desktop" } | { kind: "start-menu" } | { kind: "folder"; dir: string };
type ViewMode = "card" | "list";
type ImportResult = { added: number; skippedDuplicates: number; skippedInvalid: number };
type ItemIcon = { id: string; iconPath: string | null };

const encryptedId = "__encrypted__";
let items: Item[] = [];
let groups: Group[] = [];
let passwordSet = false;
let unlocked = false;
let activeGroup = "all";
let sortBy: SortBy = "relevance";
let viewMode: ViewMode = "card";
let appConfig: AppConfig | null = null;
let query = "";
let selected = 0;
let composingSearch = false;
let scanning: DesktopEntry[] = [];
let opening = false;
let searchSelection: [number, number] | null = null;
let pinned = false;
let selectMode = false;
const selectedIds = new Set<string>();
// 平台相关文案：macOS 无 CMD、「开始菜单」对应「应用程序」，快捷方式即 .app 应用包
const cmdLabel = isMac ? "命令" : "CMD 命令";
const shortcutLabel = isMac ? "应用程序" : "快捷方式";
const startMenuLabel = isMac ? "应用程序" : "系统开始菜单";

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
  // 匹配度：无搜索词时统一记 0 分，退化为按名称排序
  const scored = groupItems.map((item) => ({ item, score: needle ? fuzzyScore(item, needle) : 0 })).filter((entry) => !needle || entry.score > -1);
  const byName = (a: { item: Item }, b: { item: Item }) => a.item.name.localeCompare(b.item.name, "zh-CN");
  return scored.sort((a, b) => sortBy === "created" ? b.item.createdAt - a.item.createdAt
    : sortBy === "type" ? typeRank(a.item) - typeRank(b.item) || byName(a, b)
    : sortBy === "relevance" ? b.score - a.score || byName(a, b)
    : byName(a, b)).map((entry) => entry.item);
};
/** 类型排序用分组：0 命令、1 程序/快捷方式、2 文件、3 文件夹 */
function typeRank(item: Item) {
  if (item.isCmd) return 0;
  const target = item.target.toLowerCase();
  if (/\.(exe|com|bat|cmd|ps1|msi|lnk|url|app)$/.test(target)) return 1;
  return (target.split(/[\\/]/).pop() ?? "").includes(".") ? 2 : 3;
}
function fuzzyScore(item: Item, needle: string) {
  const extra = item as Item & { fullPinyin?: string; initials?: string; keywordFullPinyin?: string; keywordInitials?: string };
  const values = [item.name.toLowerCase(), item.keyword.toLowerCase(), extra.fullPinyin?.toLowerCase() ?? "", extra.initials?.toLowerCase() ?? "", extra.keywordFullPinyin?.toLowerCase() ?? "", extra.keywordInitials?.toLowerCase() ?? ""];
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
  const data = await invoke<{ items: Item[]; groups: Group[]; passwordSet: boolean; unlocked: boolean }>("list_data", { includeEncrypted: unlocked });
  // 解锁状态以后端会话为准：面板重开/页面重载后仍保持已解锁
  unlocked = data.unlocked;
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
  if (/\.(exe|bat|cmd|app)$/i.test(item.target)) return "▣";
  if (/\\[^\\]+$/.test(item.target)) return "▰";
  return "▤";
}
/** 方向键上下移动的“列数”：列表视图单列，卡片视图按容器宽度估算 */
function arrowColumns() {
  if (viewMode === "list") return 1;
  return Math.max(1, Math.floor((document.querySelector("#grid")?.clientWidth ?? 250) / 170));
}
/** 切换全局显示方式（卡片/列表），并持久化到配置 */
function setViewMode(mode: ViewMode) {
  if (mode !== "card" && mode !== "list") return;
  if (mode === viewMode) return;
  viewMode = mode;
  if (appConfig) {
    appConfig.viewMode = mode;
    void saveConfig(appConfig);
  }
  render();
}
function render() {
  const shown = displayItems(); selected = Math.max(0, Math.min(selected, Math.max(0, shown.length - 1)));
  app.innerHTML = `<section class="shell">
    <header><div class="brand">速启 <small>Quick Launch</small></div><label class="search"><span>⌕</span><input id="search" autofocus placeholder="搜索关键字、名称或拼音" value="${escape(query)}" />${query ? `<button type="button" class="search-clear" data-action="clear-search" title="清空搜索" tabindex="-1">✕</button>` : ""}</label><button data-action="add" class="primary">＋ 添加</button><button data-action="scan">扫描导入</button><button data-action="groups">管理</button><button data-action="settings" title="设置">⚙</button><button data-action="pin" title="钉住面板">${pinned ? "📌" : "📍"}</button></header>
    <nav id="tabs">${fixedGroups().map((group) => `<button class="tab ${group.id === activeGroup ? "active" : ""} ${group.id === encryptedId ? "lock" : ""}" data-group="${group.id}" draggable="${groups.some((normal) => normal.id === group.id)}">${group.id === encryptedId ? (unlocked ? "🔓" : "🔒") : ""}${escape(group.name)}</button>`).join("")}<button class="add-group" data-action="new-group" title="新建分组">＋</button></nav>
    <section class="toolbar"><span>${opening ? `<i class="loading-dot"></i>正在打开…` : activeGroup === encryptedId && !unlocked ? "加密分组已锁定" : `共 ${shown.length} 项`}</span><label>排序 <select id="sort"><option value="relevance">匹配度</option><option value="name">名称</option><option value="created">添加时间</option><option value="type">类型</option></select></label><div class="view-toggle"><button data-view="card" class="${viewMode === "card" ? "active" : ""}" title="卡片视图">▦</button><button data-view="list" class="${viewMode === "list" ? "active" : ""}" title="列表视图">☰</button></div><button data-action="select-mode" class="${selectMode ? "active" : ""}" title="多选条目">${selectMode ? "退出多选" : "多选"}</button>${activeGroup === encryptedId ? `<button data-action="password">${unlocked ? "重置密码" : passwordSet ? "解锁" : "设置密码"}</button>` : ""}</section>
    ${selectMode ? `<section class="bulk-bar"><span>已选 ${selectedIds.size} 项</span><div class="bulk-actions"><button data-action="select-all">全选</button><button data-action="select-invert">反选</button><button data-action="select-none">清空</button><button data-action="move-items" ${selectedIds.size ? "" : "disabled"}>移动到分组</button><button class="danger" data-action="delete-items" ${selectedIds.size ? "" : "disabled"}>删除</button></div></section>` : ""}
    <section id="grid" class="grid ${viewMode === "list" ? "list" : ""}">${activeGroup === encryptedId && !unlocked ? `<div class="locked"><b>🔒 加密分组</b><p>解锁后才会显示其中的启动项，也不会参与全部搜索。</p><button class="primary" data-action="password">${passwordSet ? "输入密码解锁" : "设置访问密码"}</button></div>` : shown.length ? shown.map((item, index) => { const needle = query.trim().toLowerCase(); const picked = selectedIds.has(item.id); return `<article class="card ${!selectMode && index === selected ? "selected" : ""} ${picked ? "picked" : ""}" data-id="${item.id}"><div class="icon${selectMode ? " pick" : ""}">${selectMode ? (picked ? "✓" : "") : itemIcon(item)}</div><div class="card-text"><b>${renderName(item.name, needle)}</b>${item.keyword ? `<em class="keyword" title="关键字">${renderName(item.keyword, needle)}</em>` : ""}<span>${escape(item.isCmd ? cmdLabel : item.target)}</span></div>${selectMode ? "" : `<button class="more" data-menu="${item.id}" title="更多">⋯</button>`}</article>`; }).join("") : `<div class="empty"><b>这里还没有启动项</b><p>点击“添加”，或使用扫描导入批量添加。</p></div>`}</section>
    <footer>右键空白处即可添加 · Enter 打开 · 方向键切换</footer>
  </section>`;
  const input = document.querySelector<HTMLInputElement>("#search")!;
  input.addEventListener("compositionstart", () => { composingSearch = true; });
  input.addEventListener("compositionend", () => { composingSearch = false; query = input.value; selected = 0; searchSelection = [input.selectionStart ?? query.length, input.selectionEnd ?? query.length]; render(); });
  input.addEventListener("input", () => { if (!composingSearch) { query = input.value; selected = 0; searchSelection = [input.selectionStart ?? query.length, input.selectionEnd ?? query.length]; render(); } });
  input.addEventListener("keydown", (event) => {
    if (composingSearch) return;
    const shownItems = displayItems();
    // 多选模式下 Enter 不启动条目，避免与勾选操作冲突
    if (!selectMode && event.key === "Enter" && shownItems[selected]) { event.preventDefault(); void openItem(shownItems[selected].id); }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && shownItems.length) {
      event.preventDefault();
      const width = arrowColumns();
      const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -width : width;
      selected = (selected + delta + shownItems.length) % shownItems.length;
      render();
    }
  });
  input.focus();
  if (searchSelection) input.setSelectionRange(...searchSelection);
  document.querySelector<HTMLSelectElement>("#sort")!.value = sortBy;
  document.querySelector<HTMLSelectElement>("#sort")!.onchange = (event) => { sortBy = (event.target as HTMLSelectElement).value as SortBy; render(); };
  document.querySelectorAll<HTMLElement>("[data-view]").forEach((button) => button.onclick = () => setViewMode(button.dataset.view as ViewMode));
  bindInteractions(shown);
}
function bindInteractions(shown: Item[]) {
  document.querySelectorAll<HTMLElement>("[data-action]").forEach((button) => button.onclick = () => void action(button.dataset.action!));
  document.querySelectorAll<HTMLElement>("[data-group]").forEach((tab) => { tab.onclick = () => { activeGroup = tab.dataset.group!; selected = 0; selectedIds.clear(); render(); }; tab.ondragstart = (event) => event.dataTransfer?.setData("group", tab.dataset.group!); tab.ondragover = (event) => event.preventDefault(); tab.ondrop = (event) => void reorderGroups(event, tab.dataset.group!); });
  document.querySelectorAll<HTMLElement>(".card").forEach((card) => {
    card.onclick = (event) => {
      if ((event.target as HTMLElement).closest(".more")) return;
      // 多选模式下点击卡片切换勾选，不移动键盘光标
      if (selectMode) { const id = card.dataset.id!; if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id); render(); return; }
      // 已选中的条目再次点击名称区域：直接进入内联改名
      if (card.dataset.id === shown[selected]?.id && (event.target as HTMLElement).closest(".card-text b")) { renameItemInline(card.dataset.id!); return; }
      selected = shown.findIndex((item) => item.id === card.dataset.id); render();
    };
    card.ondblclick = (event) => { if (selectMode || (event.target as HTMLElement).closest(".card-text b")) return; void openItem(card.dataset.id!); };
  });
  document.querySelectorAll<HTMLElement>("[data-menu]").forEach((button) => button.onclick = (event) => { event.stopPropagation(); showItemMenu(button.dataset.menu!, button); });
  document.querySelector("#grid")?.addEventListener("contextmenu", (event) => { if ((event.target as HTMLElement).closest(".card")) return; event.preventDefault(); openItemDialog(); });
}
async function action(type: string) {
  if (type === "add") openItemDialog();
  if (type === "clear-search") { query = ""; searchSelection = null; selected = 0; render(); }
  if (type === "scan") await openScan();
  if (type === "groups") openGroupManager();
  if (type === "new-group") openGroupDialog();
  if (type === "password") openPasswordDialog();
  if (type === "select-mode") { selectMode = !selectMode; selectedIds.clear(); render(); }
  if (type === "select-all") { displayItems().forEach((item) => selectedIds.add(item.id)); render(); }
  if (type === "select-invert") { displayItems().forEach((item) => selectedIds.has(item.id) ? selectedIds.delete(item.id) : selectedIds.add(item.id)); render(); }
  if (type === "select-none") { selectedIds.clear(); render(); }
  if (type === "delete-items") await deleteSelectedItems();
  if (type === "move-items") openMoveDialog([...selectedIds]);
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
function modal(content: string) {
  const node = document.createElement("div");
  node.className = "overlay";
  node.innerHTML = `<div class="modal">${content}</div>`;
  document.body.append(node);
  // 仅当鼠标「按下」与「松开」都落在遮罩空白处时才关闭：
  // 在弹窗内按下、拖到遮罩上松开会触发 target 为遮罩的 click，此前会误关闭
  let pressedOnBackdrop = false;
  node.addEventListener("mousedown", (event) => { pressedOnBackdrop = event.target === node; });
  node.addEventListener("mouseup", (event) => { if (event.target !== node) pressedOnBackdrop = false; });
  node.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.dataset.close !== undefined) { node.remove(); return; }
    if (target === node && pressedOnBackdrop) node.remove();
    pressedOnBackdrop = false;
  });
  return node;
}
function selectedGroup() { return activeGroup === "all" || activeGroup === "none" ? null : activeGroup; }
function openItemDialog(item?: Item) {
  const isCmd = item?.isCmd ?? false; const node = modal(`<h2>${item ? "编辑启动项" : "添加启动项"}</h2><form id="item-form"><label>名称<input name="name" required value="${escape(item?.name ?? "")}" placeholder="例如：工作资料" /></label><label>关键字<input name="keyword" value="${escape(item?.keyword ?? "")}" placeholder="用于搜索，留空则使用名称" /></label><label>类型<select name="kind"><option value="target">文件、目录、快捷方式或 URL</option><option value="cmd">${cmdLabel}</option></select></label><label>启动目标<div class="with-button"><input name="target" required value="${escape(item?.target ?? "")}" placeholder="绝对路径、https:// 或命令" /><button type="button" id="pick">选择…</button></div></label><label>分组<select name="group"><option value="">未分组</option>${groups.sort((a,b) => a.sortOrder-b.sortOrder).map((group) => `<option value="${group.id}">${escape(group.name)}</option>`).join("")}<option value="${encryptedId}">🔒 加密</option></select></label><label>自定义图标（可选）<div class="with-button"><input name="icon" value="${escape(item?.iconPath ?? "")}" placeholder="图标文件路径" /><button type="button" id="pick-icon">选择…</button></div></label><div class="modal-actions"><button type="button" data-close>取消</button><button class="primary">保存</button></div></form>`); const form = node.querySelector<HTMLFormElement>("#item-form")!; const kind = form.elements.namedItem("kind") as HTMLSelectElement; kind.value = isCmd ? "cmd" : "target"; (form.elements.namedItem("group") as HTMLSelectElement).value = item?.groupId ?? selectedGroup() ?? "";
  node.querySelector<HTMLButtonElement>("#pick")!.onclick = async () => { const path = await chooseFile({ directory: false, multiple: false }); if (typeof path === "string") (form.elements.namedItem("target") as HTMLInputElement).value = path; };
  node.querySelector<HTMLButtonElement>("#pick-icon")!.onclick = async () => { const path = await chooseFile({ multiple: false, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "ico", "svg"] }] }); if (typeof path === "string") (form.elements.namedItem("icon") as HTMLInputElement).value = path; };
  form.onsubmit = async (event) => { event.preventDefault(); const values = new FormData(form); try { await invoke("save_item", { item: { id: item?.id ?? "", name: values.get("name"), keyword: values.get("keyword") ?? "", target: values.get("target"), groupId: values.get("group") || null, isEncrypted: false, isCmd: kind.value === "cmd", iconPath: values.get("icon") || null, sortOrder: item?.sortOrder ?? 0, createdAt: item?.createdAt ?? 0 }, isCmd: kind.value === "cmd" }); node.remove(); await load(); } catch (error) { message(error); } };
}
function showItemMenu(id: string, anchor: HTMLElement) { document.querySelector(".menu")?.remove(); const menu = document.createElement("div"); menu.className = "menu"; menu.innerHTML = `<button data-edit>编辑</button><button data-open>打开</button><button data-move>移动到分组</button><button class="danger" data-delete>删除</button>`; document.body.append(menu); const box = anchor.getBoundingClientRect(); menu.style.left = `${box.left - 100}px`; menu.style.top = `${box.bottom + 4}px`; menu.querySelector("[data-edit]")!.addEventListener("click", () => { menu.remove(); openItemDialog(items.find((item) => item.id === id)); }); menu.querySelector("[data-open]")!.addEventListener("click", () => { menu.remove(); void openItem(id); }); menu.querySelector("[data-move]")!.addEventListener("click", () => { menu.remove(); const item = items.find((target) => target.id === id); if (item) openMoveDialog([id], item.groupId); }); menu.querySelector("[data-delete]")!.addEventListener("click", async () => { if (!confirm("确认删除这个启动项？")) return; try { await invoke("delete_item", { id }); menu.remove(); await load(); } catch (error) { message(error); } }); }
/** 点击已选中条目的名称：在卡片内直接把名称换成输入框，失焦 / 回车保存，Esc 取消 */
function renameItemInline(id: string) {
  const item = items.find((target) => target.id === id);
  const card = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
  const nameEl = card?.querySelector<HTMLElement>(".card-text b");
  if (!item || !card || !nameEl || card.querySelector("input.rename-input")) return;
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = item.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== item.name) {
      try { await invoke("save_item", { item: { ...item, name }, isCmd: item.isCmd }); await load(); return; }
      catch (error) { message(error); }
    }
    render();
  };
  input.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === "Enter") { event.preventDefault(); void finish(true); }
    if (event.key === "Escape") void finish(false);
  };
  input.onblur = () => void finish(true);
  input.onclick = (event) => event.stopPropagation();
  input.ondblclick = (event) => event.stopPropagation();
}
/** 批量删除多选模式下勾选的启动项 */
async function deleteSelectedItems() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  if (!confirm(`确认删除选中的 ${ids.length} 个启动项？`)) return;
  try { await invoke("delete_items", { ids }); selectedIds.clear(); await load(); }
  catch (error) { message(error); }
}
/** 移动到其他分组（可选「未分组」或已有普通分组）：支持批量多选或单个条目，currentGroupId 用于预选当前分组 */
function openMoveDialog(ids: string[], currentGroupId: string | null = null) {
  if (!ids.length) return;
  const options = [{ id: "", name: "未分组" }, ...groups.sort((a, b) => a.sortOrder - b.sortOrder), { id: encryptedId, name: "🔒 加密" }];
  const node = modal(`<h2>移动到分组</h2><form id="move-form"><label>目标分组<select name="group">${options.map((option) => `<option value="${option.id}">${escape(option.name)}</option>`).join("")}</select></label><p class="hint">共 ${ids.length} 项将移动到所选分组。</p><div class="modal-actions"><button type="button" data-close>取消</button><button class="primary">移动</button></div></form>`);
  // 预选当前分组；不在选项中的值回落到「未分组」
  node.querySelector<HTMLSelectElement>("#move-form select[name='group']")!.value = options.some((option) => option.id === currentGroupId) ? currentGroupId! : "";
  node.querySelector<HTMLFormElement>("#move-form")!.onsubmit = async (event) => {
    event.preventDefault();
    const groupId = String(new FormData(event.currentTarget as HTMLFormElement).get("group") ?? "");
    try { await invoke("move_items", { ids, groupId: groupId || null }); node.remove(); selectedIds.clear(); await load(); }
    catch (error) { message(error); }
  };
}
/** 删除分组：由用户选择仅删除分组，还是连同组内项目一起删除 */
function openDeleteGroupDialog(groupId: string, manager: HTMLElement) {
  const group = groups.find((item) => item.id === groupId);
  const count = items.filter((item) => item.groupId === groupId).length;
  const node = modal(`<h2>删除分组「${escape(group?.name ?? "")}」</h2><form id="delete-group-form"><p class="hint">该分组下有 ${count} 个启动项，请选择处理方式：</p><div class="del-options"><label><input type="radio" name="mode" value="keep" checked />仅删除分组，组内项目转为未分组</label><label><input type="radio" name="mode" value="delete" />删除分组及组内全部项目</label></div><div class="modal-actions"><button type="button" data-close>取消</button><button class="danger">确认删除</button></div></form>`);
  node.querySelector<HTMLFormElement>("#delete-group-form")!.onsubmit = async (event) => {
    event.preventDefault();
    const mode = String(new FormData(event.currentTarget as HTMLFormElement).get("mode"));
    if (mode === "delete" && !confirm(`将同时删除「${group?.name ?? ""}」中的 ${count} 个启动项，确认继续？`)) return;
    try { await invoke("delete_group", { id: groupId, deleteItems: mode === "delete" }); node.remove(); manager.remove(); await load(); }
    catch (error) { message(error); }
  };
}
function openGroupDialog(group?: Group) { const node = modal(`<h2>${group ? "重命名分组" : "新建分组"}</h2><form id="group-form"><label>分组名称<input name="name" required value="${escape(group?.name ?? "")}" /></label><div class="modal-actions"><button type="button" data-close>取消</button><button class="primary">保存</button></div></form>`); node.querySelector<HTMLFormElement>("#group-form")!.onsubmit = async (event) => { event.preventDefault(); const name = new FormData(event.currentTarget as HTMLFormElement).get("name"); try { if (group) await invoke("rename_group", { id: group.id, name }); else await invoke("create_group", { name }); node.remove(); await load(); } catch (error) { message(error); } }; }
function openGroupManager() { const node = modal(`<h2>分组管理</h2><div class="group-list">${groups.sort((a,b) => a.sortOrder-b.sortOrder).map((group) => `<div><span>${escape(group.name)}</span><button data-rename="${group.id}">重命名</button><button class="danger" data-delete-group="${group.id}">删除</button></div>`).join("") || "<p class=muted>尚未创建普通分组</p>"}</div><p class="hint">“全部”“未分组”“加密”为固定逻辑标签，不能删除。</p><div class="modal-actions"><button data-close>关闭</button><button class="primary" id="manager-add">新建分组</button></div>`); node.querySelector("#manager-add")!.addEventListener("click", () => { node.remove(); openGroupDialog(); }); node.querySelectorAll<HTMLElement>("[data-rename]").forEach((button) => button.onclick = () => { node.remove(); openGroupDialog(groups.find((group) => group.id === button.dataset.rename)); }); node.querySelectorAll<HTMLElement>("[data-delete-group]").forEach((button) => button.onclick = () => openDeleteGroupDialog(button.dataset.deleteGroup!, node)); }
function openPasswordDialog() { const resetting = passwordSet && unlocked; const node = modal(`<h2>${resetting ? "重置加密密码" : passwordSet ? "解锁加密分组" : "设置加密密码"}</h2><form id="password-form">${resetting ? `<label>当前密码<input name="current" type="password" required /></label>` : ""}<label>${passwordSet && !resetting ? "密码" : "新密码"}<input name="password" type="password" minlength="4" required /></label><p class="hint">密码仅以随机 salt 的 SHA-256 哈希保存，无法找回。</p><div class="modal-actions"><button type="button" data-close>取消</button><button class="primary">确认</button></div></form>${passwordSet && !resetting ? `<p class="hint" style="margin-top:8px"><button type="button" id="forgot-password" class="link">忘记密码？清空加密分组并重新设置</button></p>` : ""}`); node.querySelector<HTMLFormElement>("#password-form")!.onsubmit = async (event) => { event.preventDefault(); const values = new FormData(event.currentTarget as HTMLFormElement); const password = String(values.get("password")); try { if (passwordSet && !resetting) { if (!await invoke<boolean>("unlock_encrypted", { password })) throw "密码不正确"; unlocked = true; } else { await invoke("reset_password", { currentPassword: values.get("current") || null, newPassword: password }); unlocked = true; } node.remove(); activeGroup = encryptedId; await load(); } catch (error) { message(error); } }; node.querySelector<HTMLButtonElement>("#forgot-password")?.addEventListener("click", () => openClearEncryptedConfirm(node)); }

/** 忘记密码：二次确认后清空加密分组全部条目并重置密码 */
function openClearEncryptedConfirm(parent: HTMLElement) {
  const count = items.filter((item) => item.isEncrypted).length;
  const node = modal(`<h2>忘记密码</h2><p class="hint">将删除加密分组内的 ${count} 个启动项并重置密码，删除后无法恢复。确定继续吗？</p><div class="modal-actions"><button type="button" data-close>取消</button><button class="danger" id="confirm-clear">确认清空</button></div>`);
  node.querySelector<HTMLButtonElement>("#confirm-clear")!.onclick = async () => {
    try { await invoke("clear_encrypted"); parent.remove(); node.remove(); unlocked = false; activeGroup = encryptedId; await load(); } catch (error) { message(error); }
  };
}
const scanMeta = (entry: DesktopEntry) => entry.entryType === "shortcut" ? { label: shortcutLabel, icon: "↗" } : entry.entryType === "folder" ? { label: "文件夹", icon: "▰" } : { label: "文件", icon: "▤" };
function scanIcon(entry: DesktopEntry) { return entry.scanIconPath ? `<img src="${escape(convertFileSrc(entry.scanIconPath))}" alt="" />` : scanMeta(entry).icon; }
function updateScanSelection(node: HTMLElement) {
  const checked = node.querySelectorAll<HTMLInputElement>(".scan-items input.scan-entry:checked").length;
  const total = node.querySelectorAll<HTMLInputElement>(".scan-items input.scan-entry").length;
  const count = node.querySelector<HTMLElement>("#scan-count");
  if (count) count.textContent = `已选 ${checked} / ${total}`;
}
/** 渲染扫描结果（卡片 / 列表两种扁平布局共用，外层 class 控制形态） */
function renderScanEntries(entries: DesktopEntry[], chosen: Set<number>) {
  return entries.map((entry, index) => { const meta = scanMeta(entry); const folder = entry.folderName ? `<i class="scan-folder" title="所在文件夹">▰ ${escape(entry.folderName)}</i>` : ""; return `<label><input type="checkbox" class="scan-entry" value="${index}" data-type="${entry.entryType}" ${chosen.has(index) ? "checked" : ""}/><i class="scan-icon ${entry.entryType}">${scanIcon(entry)}</i><span class="scan-name">${escape(entry.name)}<em>${meta.label}</em>${folder}</span><small>${escape(entry.target)}</small></label>`; }).join("") || "<p class=muted>该目录没有可导入的文件或目录</p>";
}
/** 扫描结果树节点：children 为子目录，files 为当前目录下的文件 / 快捷方式索引 */
type ScanTreeNode = { name: string; folderIndex: number | null; children: ScanTreeNode[]; files: number[] };
/** 按相对路径把扫描结果组织成目录树 */
function buildScanTree(entries: DesktopEntry[]) {
  const root: ScanTreeNode = { name: "", folderIndex: null, children: [], files: [] };
  const dirs = new Map<string, ScanTreeNode>();
  const openDir = (segments: string[]) => {
    let current = root; let key = "";
    for (const segment of segments) {
      key = key ? `${key}/${segment}` : segment;
      let child = dirs.get(key);
      if (!child) { child = { name: segment, folderIndex: null, children: [], files: [] }; dirs.set(key, child); current.children.push(child); }
      current = child;
    }
    return current;
  };
  entries.forEach((entry, index) => {
    const segments = entry.relPath?.length ? entry.relPath : [entry.name];
    if (entry.entryType === "folder") openDir(segments).folderIndex = index;
    else openDir(segments.slice(0, -1)).files.push(index);
  });
  return root;
}
/** 渲染树状扫描结果：目录层级缩进，节点默认展开 */
function renderScanTree(entries: DesktopEntry[], chosen: Set<number>, rootLabel: string) {
  if (!entries.length) return "<p class=muted>该目录没有可导入的文件或目录</p>";
  const sortByName = (list: number[]) => [...list].sort((a, b) => entries[a].name.localeCompare(entries[b].name, "zh"));
  const renderNode = (treeNode: ScanTreeNode, isRoot = false): string => {
    const children = [...treeNode.children].sort((a, b) => a.name.localeCompare(b.name, "zh"));
    const folderIndex = treeNode.folderIndex;
    const entry = folderIndex === null ? null : entries[folderIndex];
    const box = entry
      ? `<input type="checkbox" class="scan-entry" value="${folderIndex}" data-type="${entry.entryType}" ${chosen.has(folderIndex!) ? "checked" : ""}/>`
      : `<input type="checkbox" class="scan-folder-check"/>`;
    const hasChildren = children.length > 0 || treeNode.files.length > 0;
    const files = sortByName(treeNode.files).map((index) => {
      const file = entries[index];
      return `<label class="scan-file"><input type="checkbox" class="scan-entry" value="${index}" data-type="${file.entryType}" ${chosen.has(index) ? "checked" : ""}/><i class="scan-icon ${file.entryType}">${scanIcon(file)}</i><span class="scan-name">${escape(file.name)}<em>${scanMeta(file).label}</em></span><small>${escape(file.target)}</small></label>`;
    }).join("");
    return `<div class="scan-node${hasChildren ? " has-children" : ""}">
      <div class="scan-row">
        ${hasChildren ? `<button type="button" class="scan-toggle" title="展开 / 折叠">▾</button>` : `<span class="scan-toggle-spacer"></span>`}
        ${box}
        <i class="scan-icon ${entry ? entry.entryType : "folder"}">${entry ? scanIcon(entry) : "▰"}</i>
        <span class="scan-name">${escape(isRoot ? rootLabel : treeNode.name)}${entry ? `<em>${scanMeta(entry).label}</em>` : ""}</span>
        <small>${escape(entry ? entry.target : "")}</small>
      </div>
      <div class="scan-children">${children.map((child) => renderNode(child)).join("")}${files}</div>
    </div>`;
  };
  return renderNode(buildScanTree(entries), true);
}
/** 依据子节点勾选情况刷新目录节点的勾选 / 半选状态（自底向上） */
function refreshScanTreeChecks(container: HTMLElement) {
  [...container.querySelectorAll<HTMLElement>(".scan-node")].reverse().forEach((treeNode) => {
    const box = treeNode.querySelector<HTMLInputElement>(":scope > .scan-row input");
    const children = treeNode.querySelector<HTMLElement>(":scope > .scan-children");
    if (!box || !children) return;
    const inputs = [...children.querySelectorAll<HTMLInputElement>("input")];
    if (!inputs.length) { box.indeterminate = false; return; }
    const checked = inputs.filter((input) => input.checked).length;
    box.checked = checked === inputs.length;
    box.indeterminate = checked > 0 && checked < inputs.length;
  });
}
async function openScan() {
  let scanView: "tree" | "card" | "list" = "tree";
  let chosen = new Set<number>();
  const node = modal(`<h2>扫描导入<button type="button" class="scan-max" id="scan-max" title="最大化 / 还原">⛶</button></h2><p class="hint">默认扫描桌面，也可以选择其他文件夹或${startMenuLabel}；仅在导入所选快捷方式时解析真实目标，重复项会自动忽略。</p>
    <div class="scan-bulk"><span id="scan-source">来源：桌面</span><div><label class="scan-check"><input type="checkbox" id="scan-recursive" />扫描子文件夹</label><label class="scan-check"><input type="checkbox" id="group-by-folder" checked />按文件夹名称分组</label><button type="button" id="pick-start-menu">${startMenuLabel}</button><button type="button" id="pick-folder">选择文件夹…</button></div></div>
    <div id="scan-body"></div>
    <div class="modal-actions"><button data-close>取消</button><button class="primary" id="import">导入已选</button></div>`);
  node.classList.add("scan-overlay");
  const scanModal = node.querySelector<HTMLElement>(".modal")!;
  // 最大化切换：窗口 95% 铺满，再次点击还原
  node.querySelector<HTMLButtonElement>("#scan-max")!.onclick = () => scanModal.classList.toggle("max");
  const sourceText = node.querySelector<HTMLElement>("#scan-source")!;
  const body = node.querySelector<HTMLElement>("#scan-body")!;
  const importButton = node.querySelector<HTMLButtonElement>("#import")!;
  const recursiveInput = node.querySelector<HTMLInputElement>("#scan-recursive")!;
  const groupByFolderInput = node.querySelector<HTMLInputElement>("#group-by-folder")!;
  const describe = (src: ScanSource) => src.kind === "folder" ? src.dir : src.kind === "start-menu" ? startMenuLabel : "桌面";
  let currentSource: ScanSource = { kind: "desktop" };
  const refresh = async (source: ScanSource) => {
    currentSource = source;
    importButton.disabled = true;
    body.innerHTML = `<p class="muted"><i class="loading-dot"></i>正在扫描…</p>`;
    const recursive = recursiveInput.checked;
    try {
      scanning = source.kind === "folder" ? await invoke<DesktopEntry[]>("scan_folder", { dir: source.dir, recursive })
        : await invoke<DesktopEntry[]>(source.kind === "start-menu" ? "scan_start_menu" : "scan_desktop", { recursive });
    }
    catch (error) { body.innerHTML = ""; importButton.disabled = false; message(error); return; }
    sourceText.textContent = `来源：${describe(source)}${recursive ? "（含子文件夹）" : ""}`;
    // 默认勾选全部快捷方式
    chosen = new Set(scanning.map((entry, index) => entry.isShortcut ? index : -1).filter((index) => index >= 0));
    const countByType = (type: DesktopEntry["entryType"]) => scanning.filter((entry) => entry.entryType === type).length;
    const rootLabel = source.kind === "folder" ? (source.dir.split(/[\\/]/).filter(Boolean).pop() ?? source.dir) : describe(source);
    const syncChosen = () => { chosen = new Set([...body.querySelectorAll<HTMLInputElement>(".scan-items input.scan-entry:checked")].map((input) => Number(input.value))); };
    const bindItems = () => {
      const container = body.querySelector<HTMLElement>(".scan-items")!;
      if (scanView !== "tree") {
        container.querySelectorAll<HTMLInputElement>("input.scan-entry").forEach((input) => input.onchange = () => { syncChosen(); updateScanSelection(node); });
        return;
      }
      container.querySelectorAll<HTMLElement>(".scan-node").forEach((treeNode) => {
        const box = treeNode.querySelector<HTMLInputElement>(":scope > .scan-row input");
        if (box) box.onchange = () => {
          treeNode.querySelectorAll<HTMLInputElement>(":scope > .scan-children input").forEach((input) => { input.checked = box.checked; input.indeterminate = false; });
          refreshScanTreeChecks(container); syncChosen(); updateScanSelection(node);
        };
        const row = treeNode.querySelector<HTMLElement>(":scope > .scan-row")!;
        const toggle = () => { treeNode.classList.toggle("collapsed"); row.querySelector<HTMLElement>(".scan-toggle")!.textContent = treeNode.classList.contains("collapsed") ? "▸" : "▾"; };
        row.querySelector<HTMLButtonElement>(".scan-toggle")?.addEventListener("click", (event) => { event.preventDefault(); toggle(); });
        row.querySelector<HTMLElement>(".scan-name")?.addEventListener("click", () => { if (treeNode.classList.contains("has-children")) toggle(); });
      });
      container.querySelectorAll<HTMLInputElement>(".scan-file input").forEach((input) => input.onchange = () => { refreshScanTreeChecks(container); syncChosen(); updateScanSelection(node); });
      refreshScanTreeChecks(container);
    };
    const renderList = () => {
      body.innerHTML = `<div class="scan-bulk"><span id="scan-count"></span><div class="scan-view-toggle"><button type="button" data-scan-view="tree" class="${scanView === "tree" ? "active" : ""}" title="树状布局">🌲</button><button type="button" data-scan-view="card" class="${scanView === "card" ? "active" : ""}" title="卡片布局">▦</button><button type="button" data-scan-view="list" class="${scanView === "list" ? "active" : ""}" title="列表布局">☰</button></div><div><button type="button" data-select="shortcut">全选快捷方式 (${countByType("shortcut")})</button><button type="button" data-select="file">全选文件 (${countByType("file")})</button><button type="button" data-select="folder">全选文件夹 (${countByType("folder")})</button><button type="button" data-select="all">全选</button><button type="button" data-select="none">取消全选</button></div></div>
        <div class="scan-items ${scanView}">${scanView === "tree" ? renderScanTree(scanning, chosen, rootLabel) : renderScanEntries(scanning, chosen)}</div>`;
      const toggle = (type: string) => {
        body.querySelectorAll<HTMLInputElement>(".scan-items input.scan-entry").forEach((input) => {
          input.checked = type === "all" ? true : type === "none" ? false : input.dataset.type === type;
          input.indeterminate = false;
        });
        const container = body.querySelector<HTMLElement>(".scan-items");
        if (container && scanView === "tree") refreshScanTreeChecks(container);
        syncChosen();
        updateScanSelection(node);
      };
      body.querySelectorAll<HTMLButtonElement>("[data-select]").forEach((button) => button.onclick = () => toggle(button.dataset.select!));
      // 视图切换：重建列表，保留已勾选状态
      body.querySelectorAll<HTMLButtonElement>("[data-scan-view]").forEach((button) => button.onclick = () => {
        syncChosen();
        scanView = button.dataset.scanView as "tree" | "card" | "list";
        renderList();
      });
      bindItems();
      updateScanSelection(node);
    };
    renderList();
    importButton.disabled = false;
  };
  node.querySelector<HTMLButtonElement>("#pick-folder")!.onclick = async () => {
    const dir = await chooseFile({ directory: true, multiple: false });
    if (typeof dir === "string") await refresh({ kind: "folder", dir });
  };
  // 开始菜单 / 应用程序目录层级较多，切换到该来源时默认勾选“扫描子文件夹”
  node.querySelector<HTMLButtonElement>("#pick-start-menu")!.onclick = async () => { recursiveInput.checked = true; await refresh({ kind: "start-menu" }); };
  recursiveInput.onchange = () => { void refresh(currentSource); };
  importButton.addEventListener("click", async () => {
    const selectedEntries = [...node.querySelectorAll<HTMLInputElement>(".scan-items input.scan-entry:checked")].map((input) => scanning[Number(input.value)]);
    if (!selectedEntries.length) { message("请至少选择一项"); return; }
    importButton.disabled = true; importButton.innerHTML = `<i class="loading-dot"></i>正在导入…`;
    node.querySelectorAll<HTMLButtonElement>("button").forEach((control) => { if (control !== importButton) control.disabled = true; });
    try {
      const result = await invoke<ImportResult>("import_scanned", { entries: selectedEntries, groupId: selectedGroup(), groupByFolder: groupByFolderInput.checked });
      node.remove(); await load();
      const skipped = result.skippedDuplicates + result.skippedInvalid;
      alert(`已导入 ${result.added} 项${skipped ? `；跳过重复 ${result.skippedDuplicates} 项、无效 ${result.skippedInvalid} 项。` : "。"}`);
    } catch (error) {
      importButton.disabled = false; importButton.textContent = "导入已选";
      node.querySelectorAll<HTMLButtonElement>("button").forEach((control) => control.disabled = false);
      message(error);
    }
  });
  await refresh(currentSource);
}
async function reorderGroups(event: DragEvent, targetId: string) { event.preventDefault(); const sourceId = event.dataTransfer?.getData("group"); if (!sourceId || sourceId === targetId) return; const reordered = groups.sort((a,b) => a.sortOrder-b.sortOrder); const from = reordered.findIndex((group) => group.id === sourceId); const to = reordered.findIndex((group) => group.id === targetId); if (from < 0 || to < 0) return; reordered.splice(to, 0, reordered.splice(from, 1)[0]); try { await invoke("save_group_order", { ids: reordered.map((group) => group.id) }); await load(); } catch (error) { message(error); } }
window.addEventListener("keydown", (event) => { const target = event.target as HTMLElement; if (target.matches("input, textarea, select")) { if (event.key === "Escape") document.querySelector<HTMLElement>(".overlay")?.remove(); return; } const shown = displayItems(); if (event.key === "Enter" && shown[selected]) { event.preventDefault(); void openItem(shown[selected].id); } if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && shown.length) { event.preventDefault(); const width = arrowColumns(); const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -width : width; selected = (selected + delta + shown.length) % shown.length; render(); } if (event.key === "Escape") document.querySelector<HTMLElement>(".overlay")?.remove(); });
void load();
// 面板重新显示时同步后端解锁状态：选择「每次打开面板都需输入密码」时，隐藏即上锁，重开需重新输入
listen("panel-shown", () => { void load(); });
// 条目「⋯」菜单：点击菜单外任意位置即关闭（「⋯」按钮自身已 stopPropagation，不影响刚打开的菜单）
document.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest(".menu")) return;
  document.querySelector(".menu")?.remove();
});
// 应用外观配置（主题、高亮色、字号、窗口效果、面板背景）并监听设置页变更实时生效
loadConfig().then(async (cfg) => {
  appConfig = cfg;
  viewMode = cfg.viewMode === "list" ? "list" : "card";
  applyAppearance(cfg);
  applyWindowEffect(cfg.windowEffect);
  await applyWindowBackground(cfg.background, true);
  pinned = cfg.alwaysOnTop;
  render();
});
listen<AppConfig>("config-changed", async (event) => {
  const cfg = event.payload;
  appConfig = cfg;
  applyAppearance(cfg);
  applyWindowEffect(cfg.windowEffect);
  await applyWindowBackground(cfg.background, true);
  const mode: ViewMode = cfg.viewMode === "list" ? "list" : "card";
  const viewChanged = mode !== viewMode;
  viewMode = mode;
  // 钉住状态可能来自托盘菜单、显示方式可能来自设置页，需实时反映到面板
  if (cfg.alwaysOnTop !== pinned || viewChanged) {
    pinned = cfg.alwaysOnTop;
    render();
  }
});

// ---------- 应用内更新：启动自动检查，发现新版在面板顶部显示横幅 ----------
const updateBannerEl = document.createElement("div");
updateBannerEl.id = "update-banner";
updateBannerEl.className = "update-banner";
updateBannerEl.hidden = true;
updateBannerEl.innerHTML = `<span id="update-banner-text">发现新版本</span><button id="update-banner-btn" class="small" type="button">去更新</button>`;
document.body.prepend(updateBannerEl);
updateBannerEl.querySelector<HTMLButtonElement>("#update-banner-btn")!.onclick = async () => {
  await invoke("open_settings_window");
  await emit("open-update-tab");
};
if (autoCheckEnabled()) {
  checkUpdate().then((info) => {
    if (info) {
      updateBannerEl.querySelector<HTMLSpanElement>("#update-banner-text")!.textContent = `发现新版本 v${info.version}`;
      updateBannerEl.hidden = false;
    }
  });
}
