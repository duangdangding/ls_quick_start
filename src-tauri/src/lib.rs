use pinyin::ToPinyin;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, path::{Path, PathBuf}, process::Command, sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::{SystemTime, UNIX_EPOCH}};
use tauri::{Emitter, Manager, State};
use tauri::menu::{Menu, MenuItem, CheckMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

const ENCRYPTED_GROUP: &str = "__encrypted__";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherItem {
    id: String,
    name: String,
    target: String,
    group_id: Option<String>,
    is_encrypted: bool,
    #[serde(default)]
    is_cmd: bool,
    icon_path: Option<String>,
    sort_order: i64,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Group { id: String, name: String, sort_order: i64 }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordHash { salt: String, hash: String }

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Store { items: Vec<LauncherItem>, groups: Vec<Group>, password: Option<PasswordHash> }

struct AppData { store: Mutex<Store>, path: PathBuf }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    hotkey: String,
    autostart: bool,
    silent_start: bool,
    always_on_top: bool,
    remember_size: bool,
    window_width: i32,
    window_height: i32,
    theme: String,
    font_family: String,
    font_size: i32,
    highlight_color: String,
    window_effect: String,
    config_dir: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            hotkey: "Win+`".into(),
            autostart: false,
            silent_start: false,
            always_on_top: false,
            remember_size: false,
            window_width: 980,
            window_height: 680,
            theme: "dark".into(),
            font_family: "system-ui".into(),
            font_size: 14,
            highlight_color: "#7c3aed".into(),
            window_effect: "default".into(),
            config_dir: String::new(),
        }
    }
}

struct ConfigState { config: Mutex<AppConfig>, config_path: PathBuf, pinned: AtomicBool }

fn config_path() -> PathBuf {
    dirs::config_dir().or_else(dirs::data_local_dir).unwrap_or_else(|| PathBuf::from(".")).join("suqi").join("config.json")
}

fn load_config() -> AppConfig {
    let path = config_path();
    fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_config_file(config: &AppConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    fs::write(&path, serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListResult { items: Vec<LauncherItem>, groups: Vec<Group>, password_set: bool }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchText { id: String, name: String, full_pinyin: String, initials: String }

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DesktopEntry {
    name: String,
    source_path: String,
    target: String,
    is_shortcut: bool,
    entry_type: String,
    scan_icon_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult { added: usize, skipped_duplicates: usize, skipped_invalid: usize }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemIcon { id: String, icon_path: Option<String> }

fn now() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64 }
fn new_id() -> String { let mut bytes = [0u8; 12]; rand::thread_rng().fill_bytes(&mut bytes); hex::encode(bytes) }
fn data_path() -> PathBuf {
    dirs::data_local_dir().or_else(dirs::data_dir).unwrap_or_else(|| PathBuf::from(".")).join("suqi").join("launchers.json")
}
fn load_store(path: &Path) -> Store {
    let mut store: Store = fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    for item in &mut store.items { item.target = display_path(&item.target); }
    store
}
fn save(store: &Store, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败：{e}"))?; }
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?).map_err(|e| format!("保存数据失败：{e}"))?;
    fs::rename(temp, path).map_err(|e| format!("保存数据失败：{e}"))
}
fn valid_name(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&c) || matches!(c, ' ' | '-' | '_' | '－' | '—' | '(' | ')' | '（' | '）' | '.' | '·'))
}
fn check_name(name: &str) -> Result<(), String> { if valid_name(name) { Ok(()) } else { Err("名称仅允许中文、英文、数字、空格及常见连字符".into()) } }
fn is_url(value: &str) -> bool { value.starts_with("http://") || value.starts_with("https://") }
fn normalize_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    if !is_url(value) || value.contains(char::is_whitespace) { return Err("URL 仅支持以 http:// 或 https:// 开头的有效地址".into()); }
    let (scheme, rest) = value.split_once("://").unwrap();
    if rest.is_empty() { return Err("URL 地址不能为空".into()); }
    Ok(format!("{}://{}", scheme.to_ascii_lowercase(), rest.trim_end_matches('/')))
}
fn resolve_lnk(path: &Path) -> String {
    #[cfg(windows)] {
        let escaped = path.display().to_string().replace('\'', "''");
        if let Ok(output) = Command::new("powershell").args(["-NoProfile", "-Command", &format!("$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}'); $s.TargetPath", escaped)]).output() {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !value.is_empty() { return value; }
        }
    }
    path.display().to_string()
}
fn display_path(value: impl AsRef<str>) -> String {
    value.as_ref().strip_prefix(r"\\?\").unwrap_or(value.as_ref()).to_string()
}
fn ps_quote(value: impl AsRef<str>) -> String { format!("'{}'", value.as_ref().replace('\'', "''")) }
fn resolve_shortcuts(paths: &[PathBuf]) -> Vec<String> {
    #[cfg(windows)] {
        if paths.is_empty() { return Vec::new(); }
        let values = paths.iter().map(|path| ps_quote(path.display().to_string())).collect::<Vec<_>>().join(",");
        let script = format!("$w=New-Object -ComObject WScript.Shell; @({values}) | ForEach-Object {{ try {{ $w.CreateShortcut($_).TargetPath }} catch {{ '' }} }}");
        if let Ok(output) = Command::new("powershell").args(["-NoProfile", "-Command", &script]).output() {
            return String::from_utf8_lossy(&output.stdout).lines().map(|value| display_path(value.trim())).collect();
        }
    }
    paths.iter().map(|path| display_path(path.display().to_string())).collect()
}
fn extract_icons(pairs: &[(PathBuf, PathBuf)]) {
    #[cfg(windows)] {
        if pairs.is_empty() { return; }
        let values = pairs.iter().flat_map(|(input, output)| [ps_quote(input.display().to_string()), ps_quote(output.display().to_string())]).collect::<Vec<_>>().join(",");
        let script = format!("Add-Type -AssemblyName System.Drawing; $p=@({values}); for($i=0;$i -lt $p.Count;$i+=2){{ try {{ $icon=[System.Drawing.Icon]::ExtractAssociatedIcon($p[$i]); if($icon){{ $bitmap=$icon.ToBitmap(); $bitmap.Save($p[$i+1],[System.Drawing.Imaging.ImageFormat]::Png); $bitmap.Dispose(); $icon.Dispose() }} }} catch {{}} }}");
        let _ = Command::new("powershell").args(["-NoProfile", "-Command", &script]).output();
    }
}
fn normalize_target(value: &str, is_cmd: bool) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() { return Err("启动目标不能为空".into()); }
    if is_cmd { return Ok(value.to_string()); }
    if is_url(value) { return normalize_url(value); }
    let path = Path::new(value);
    if !path.is_absolute() { return Err("本地路径必须为绝对路径".into()); }
    let resolved = if path.extension().is_some_and(|x| x.eq_ignore_ascii_case("lnk")) { PathBuf::from(resolve_lnk(path)) } else { path.to_path_buf() };
    fs::canonicalize(&resolved).map_err(|_| "本地路径不存在或无法访问".to_string()).map(|p| display_path(p.display().to_string()))
}
fn pinyin_text(name: &str) -> (String, String) {
    let parts: Vec<String> = name.to_pinyin().map(|x| x.map(|p| p.plain().to_string()).unwrap_or_default()).collect();
    let full = parts.join("");
    let initials = parts.iter().filter_map(|p| p.chars().next()).collect();
    (full, initials)
}
fn encrypted(item: &LauncherItem) -> bool { item.is_encrypted || item.group_id.as_deref() == Some(ENCRYPTED_GROUP) }
fn persist(data: &AppData, store: &Store) -> Result<(), String> { save(store, &data.path) }

#[tauri::command]
fn list_data(data: State<'_, AppData>, include_encrypted: bool) -> ListResult {
    let store = data.store.lock().unwrap();
    ListResult { items: store.items.iter().filter(|item| include_encrypted || !encrypted(item)).cloned().collect(), groups: store.groups.clone(), password_set: store.password.is_some() }
}
#[tauri::command]
fn searchable_items(data: State<'_, AppData>, include_encrypted: bool) -> Vec<SearchText> {
    data.store.lock().unwrap().items.iter().filter(|item| include_encrypted || !encrypted(item)).map(|item| { let (full_pinyin, initials) = pinyin_text(&item.name); SearchText { id: item.id.clone(), name: item.name.clone(), full_pinyin, initials } }).collect()
}
#[tauri::command]
fn save_item(data: State<'_, AppData>, mut item: LauncherItem, is_cmd: bool) -> Result<LauncherItem, String> {
    check_name(&item.name)?;
    item.name = item.name.trim().to_string();
    item.target = normalize_target(&item.target, is_cmd)?;
    item.is_encrypted = item.group_id.as_deref() == Some(ENCRYPTED_GROUP);
    item.is_cmd = is_cmd;
    let mut store = data.store.lock().unwrap();
    if item.group_id.as_deref() != Some(ENCRYPTED_GROUP) && item.group_id.as_ref().is_some_and(|id| !store.groups.iter().any(|g| &g.id == id)) { return Err("所选分组不存在".into()); }
    if store.items.iter().any(|x| x.id != item.id && x.target.eq_ignore_ascii_case(&item.target)) { return Err("该真实目标已存在，不能重复添加".into()); }
    if item.id.is_empty() { item.id = new_id(); item.created_at = now(); item.sort_order = store.items.iter().map(|x| x.sort_order).max().unwrap_or(-1) + 1; store.items.push(item.clone()); } else if let Some(existing) = store.items.iter_mut().find(|x| x.id == item.id) { item.created_at = existing.created_at; item.sort_order = existing.sort_order; *existing = item.clone(); } else { return Err("要编辑的启动项不存在".into()); }
    persist(&data, &store)?; Ok(item)
}
#[tauri::command]
fn delete_item(data: State<'_, AppData>, id: String) -> Result<(), String> { let mut store = data.store.lock().unwrap(); store.items.retain(|x| x.id != id); persist(&data, &store) }
#[tauri::command]
fn open_item(data: State<'_, AppData>, id: String, unlocked: bool) -> Result<(), String> {
    let item = data.store.lock().unwrap().items.iter().find(|x| x.id == id).cloned().ok_or("启动项不存在")?;
    if encrypted(&item) && !unlocked { return Err("请先解锁加密分组".into()); }
    #[cfg(windows)] {
        if item.is_cmd {
            Command::new("cmd").args(["/C", &item.target]).spawn().map_err(|e| format!("无法打开目标：{e}"))?;
        } else {
            Command::new("explorer.exe").arg(&item.target).spawn().map_err(|e| format!("无法打开目标：{e}"))?;
        }
    }
    #[cfg(not(windows))] {
        let mut command = if item.is_cmd { let mut c = Command::new("sh"); c.args(["-c", &item.target]); c } else { let mut c = Command::new("open"); c.arg(&item.target); c };
        command.spawn().map_err(|e| format!("无法打开目标：{e}"))?;
    }
    Ok(())
}
#[tauri::command]
fn create_group(data: State<'_, AppData>, name: String) -> Result<Group, String> { check_name(&name)?; let mut store = data.store.lock().unwrap(); if store.groups.iter().any(|g| g.name == name.trim()) { return Err("已存在同名分组".into()); } let group = Group { id: new_id(), name: name.trim().into(), sort_order: store.groups.iter().map(|g| g.sort_order).max().unwrap_or(-1) + 1 }; store.groups.push(group.clone()); persist(&data, &store)?; Ok(group) }
#[tauri::command]
fn rename_group(data: State<'_, AppData>, id: String, name: String) -> Result<(), String> { check_name(&name)?; let mut store = data.store.lock().unwrap(); if store.groups.iter().any(|g| g.id != id && g.name == name.trim()) { return Err("已存在同名分组".into()); } store.groups.iter_mut().find(|g| g.id == id).ok_or("分组不存在")?.name = name.trim().into(); persist(&data, &store) }
#[tauri::command]
fn delete_group(data: State<'_, AppData>, id: String) -> Result<(), String> { let mut store = data.store.lock().unwrap(); if !store.groups.iter().any(|g| g.id == id) { return Err("分组不存在".into()); } store.groups.retain(|g| g.id != id); for item in &mut store.items { if item.group_id.as_deref() == Some(&id) { item.group_id = None; } } persist(&data, &store) }
#[tauri::command]
fn save_group_order(data: State<'_, AppData>, ids: Vec<String>) -> Result<(), String> { let mut store = data.store.lock().unwrap(); for (index, id) in ids.iter().enumerate() { if let Some(group) = store.groups.iter_mut().find(|g| &g.id == id) { group.sort_order = index as i64; } } persist(&data, &store) }
#[tauri::command]
fn save_item_order(data: State<'_, AppData>, ids: Vec<String>) -> Result<(), String> { let mut store = data.store.lock().unwrap(); for (index, id) in ids.iter().enumerate() { if let Some(item) = store.items.iter_mut().find(|x| &x.id == id) { item.sort_order = index as i64; } } persist(&data, &store) }
fn password_hash(password: &str, salt: &str) -> String { let mut hasher = Sha256::new(); hasher.update(salt.as_bytes()); hasher.update(password.as_bytes()); hex::encode(hasher.finalize()) }
#[tauri::command]
fn unlock_encrypted(data: State<'_, AppData>, password: String) -> Result<bool, String> { let store = data.store.lock().unwrap(); let Some(saved) = &store.password else { return Err("请先设置密码".into()) }; Ok(password_hash(&password, &saved.salt) == saved.hash) }
#[tauri::command]
fn reset_password(data: State<'_, AppData>, current_password: Option<String>, new_password: String) -> Result<(), String> { if new_password.trim().len() < 4 { return Err("密码至少需要 4 个字符".into()); } let mut store = data.store.lock().unwrap(); if let Some(saved) = &store.password { let current = current_password.ok_or("请输入当前密码")?; if password_hash(&current, &saved.salt) != saved.hash { return Err("当前密码不正确".into()); } } let mut bytes = [0u8; 16]; rand::thread_rng().fill_bytes(&mut bytes); let salt = hex::encode(bytes); store.password = Some(PasswordHash { hash: password_hash(&new_password, &salt), salt }); persist(&data, &store) }
#[tauri::command]
fn scan_desktop() -> Result<Vec<DesktopEntry>, String> {
    let desktop = dirs::desktop_dir().or_else(|| dirs::home_dir().map(|p| p.join("Desktop"))).ok_or("无法定位桌面目录")?;
    let mut entries = Vec::new();
    let icon_dir = dirs::data_local_dir().or_else(dirs::data_dir).unwrap_or_else(|| PathBuf::from(".")).join("suqi").join("scan-icons");
    let _ = fs::create_dir_all(&icon_dir);
    let mut icon_pairs = Vec::new();
    for entry in fs::read_dir(desktop).map_err(|e| format!("读取桌面失败：{e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.eq_ignore_ascii_case("desktop.ini") { continue; }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let shortcut = path.extension().is_some_and(|x| x.eq_ignore_ascii_case("lnk"));
        let entry_type = if shortcut { "shortcut" } else if kind.is_dir() { "folder" } else if kind.is_file() { "file" } else { continue };
        // 扫描阶段只读取目录项元数据；快捷方式的真实目标在导入已选项时再解析，避免每个 .lnk 启动一次 PowerShell。
        let source_path = display_path(path.display().to_string());
        let mut hasher = Sha256::new(); hasher.update(source_path.as_bytes());
        let icon_file = icon_dir.join(format!("{}.png", hex::encode(hasher.finalize())));
        if !icon_file.exists() { icon_pairs.push((path.clone(), icon_file.clone())); }
        entries.push(DesktopEntry {
            name: path.file_stem().or_else(|| path.file_name()).unwrap_or_default().to_string_lossy().into(),
            target: source_path.clone(),
            source_path,
            is_shortcut: shortcut,
            entry_type: entry_type.into(),
            scan_icon_path: None,
        });
    }
    extract_icons(&icon_pairs);
    for entry in &mut entries {
        let mut hasher = Sha256::new(); hasher.update(entry.source_path.as_bytes());
        let icon_file = icon_dir.join(format!("{}.png", hex::encode(hasher.finalize())));
        entry.scan_icon_path = icon_file.exists().then(|| display_path(icon_file.display().to_string()));
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}
#[tauri::command]
fn import_scanned(data: State<'_, AppData>, entries: Vec<DesktopEntry>, group_id: Option<String>) -> Result<ImportResult, String> {
    let shortcut_paths: Vec<PathBuf> = entries.iter().filter(|entry| entry.is_shortcut).map(|entry| PathBuf::from(&entry.source_path)).collect();
    let shortcut_targets = resolve_shortcuts(&shortcut_paths);
    let mut shortcut_index = 0;
    let mut prepared = Vec::new();
    let mut skipped_invalid = 0;
    for entry in entries {
        if entry.name.trim().is_empty() { skipped_invalid += 1; continue; }
        let candidate = if entry.is_shortcut {
            let target = shortcut_targets.get(shortcut_index).cloned().unwrap_or_default();
            shortcut_index += 1;
            target
        } else { entry.source_path };
        match normalize_target(&candidate, false) {
            Ok(target) => prepared.push((entry.name, target)),
            Err(_) => skipped_invalid += 1,
        }
    }
    let mut store = data.store.lock().unwrap();
    let mut known: HashSet<String> = store.items.iter().map(|item| item.target.to_lowercase()).collect();
    let mut added = 0;
    let mut skipped_duplicates = 0;
    let mut order = store.items.iter().map(|item| item.sort_order).max().unwrap_or(-1) + 1;
    for (name, target) in prepared {
        if !known.insert(target.to_lowercase()) { skipped_duplicates += 1; continue; }
        store.items.push(LauncherItem { id: new_id(), name, target, group_id: group_id.clone(), is_encrypted: false, is_cmd: false, icon_path: None, sort_order: order, created_at: now() });
        order += 1;
        added += 1;
    }
    persist(&data, &store)?;
    Ok(ImportResult { added, skipped_duplicates, skipped_invalid })
}

#[tauri::command]
fn item_icons(data: State<'_, AppData>) -> Vec<ItemIcon> {
    let items = data.store.lock().unwrap().items.clone();
    let cache_dir = data.path.parent().unwrap_or(Path::new(".")).join("icons");
    let _ = fs::create_dir_all(&cache_dir);
    #[cfg(windows)] {
        let pairs = items.iter().filter_map(|item| {
            if item.icon_path.is_some() || item.is_cmd || is_url(&item.target) { return None; }
            let output = cache_dir.join(format!("{}.png", item.id));
            (!output.exists()).then(|| (PathBuf::from(&item.target), output))
        }).collect::<Vec<_>>();
        extract_icons(&pairs);
    }
    items.into_iter().map(|item| {
        let cached = cache_dir.join(format!("{}.png", item.id));
        ItemIcon { id: item.id, icon_path: item.icon_path.or_else(|| cached.exists().then(|| display_path(cached.display().to_string()))) }
    }).collect()
}

// ---------- 设置页命令 ----------

#[tauri::command]
fn get_config(state: State<'_, ConfigState>) -> AppConfig { state.config.lock().unwrap().clone() }

#[tauri::command]
fn save_config(state: State<'_, ConfigState>, app: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    *state.config.lock().unwrap() = config.clone();
    save_config_file(&config)?;
    register_hotkey(&app, &config.hotkey)?;
    apply_autostart(&app, config.autostart);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_always_on_top(config.always_on_top);
    }
    apply_window_effect_all(&app, &config.window_effect, config.theme != "light");
    let _ = app.emit("config-changed", config);
    Ok(())
}

#[tauri::command]
fn get_db_info(data: State<'_, AppData>) -> serde_json::Value {
    let store = data.store.lock().unwrap();
    let size = fs::metadata(&data.path).map(|m| m.len()).unwrap_or(0);
    serde_json::json!({
        "path": display_path(data.path.display().to_string()),
        "size": size,
        "itemCount": store.items.len(),
        "groupCount": store.groups.len(),
        "passwordSet": store.password.is_some(),
    })
}

#[tauri::command]
fn export_data(data: State<'_, AppData>) -> Result<String, String> {
    let store = data.store.lock().unwrap();
    serde_json::to_string_pretty(&*store).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_data(data: State<'_, AppData>, json: String) -> Result<(), String> {
    let store: Store = serde_json::from_str(&json).map_err(|e| format!("导入数据格式错误: {e}"))?;
    *data.store.lock().unwrap() = store;
    let snapshot = data.store.lock().unwrap();
    persist(&data, &snapshot)?;
    Ok(())
}

#[tauri::command]
fn show_panel(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if !win.is_visible().unwrap_or(false) {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

#[tauri::command]
fn hide_panel(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

#[tauri::command]
fn set_panel_pinned(state: State<'_, ConfigState>, pinned: bool) { state.pinned.store(pinned, Ordering::SeqCst); }

#[tauri::command]
fn get_panel_pinned(state: State<'_, ConfigState>) -> bool { state.pinned.load(Ordering::SeqCst) }

#[tauri::command]
fn set_window_effect(app: tauri::AppHandle, state: State<'_, ConfigState>, effect: String) -> Result<(), String> {
    const VALID: [&str; 4] = ["default", "acrylic", "vibrancy", "mica"];
    if !VALID.contains(&effect.as_str()) { return Err(format!("未知的窗口效果: {effect}")); }
    let mut cfg = state.config.lock().unwrap();
    cfg.window_effect = effect;
    let cfg_clone = cfg.clone();
    save_config_file(&cfg_clone)?;
    apply_window_effect_all(&app, &cfg_clone.window_effect, cfg_clone.theme != "light");
    let _ = app.emit("config-changed", cfg_clone);
    Ok(())
}

#[tauri::command]
fn get_config_dir() -> String { display_path(config_path().parent().unwrap_or(Path::new(".")).display().to_string()) }

#[tauri::command]
fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    open_settings_window_internal(&app)
}

fn open_settings_window_internal(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show(); let _ = w.set_focus();
    }
    Ok(())
}

#[tauri::command]
fn set_always_on_top(state: State<'_, ConfigState>, app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.always_on_top = enable;
    let snapshot = cfg.clone();
    save_config_file(&snapshot)?;
    if let Some(win) = app.get_webview_window("main") { let _ = win.set_always_on_top(enable); }
    Ok(())
}

// ---------- 托盘 / 快捷键 / 自启 ----------

fn parse_hotkey(s: &str) -> Option<Shortcut> {
    let mut mods = Modifiers::empty();
    let mut code: Option<Code> = None;
    for part in s.split('+') {
        match part.trim().to_lowercase().as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "shift" => mods |= Modifiers::SHIFT,
            "alt" => mods |= Modifiers::ALT,
            "win" | "super" | "meta" | "cmd" => mods |= Modifiers::SUPER,
            other => code = code_from_name(other),
        }
    }
    code.map(|c| Shortcut::new(Some(mods), c))
}

fn code_from_name(name: &str) -> Option<Code> {
    let upper = name.to_uppercase();
    Some(match upper.as_str() {
        "`" | "~" | "BACKQUOTE" => Code::Backquote,
        "SPACE" => Code::Space,
        "ESCAPE" => Code::Escape,
        "ENTER" | "RETURN" => Code::Enter,
        "TAB" => Code::Tab,
        "UP" => Code::ArrowUp, "DOWN" => Code::ArrowDown, "LEFT" => Code::ArrowLeft, "RIGHT" => Code::ArrowRight,
        "A" => Code::KeyA, "B" => Code::KeyB, "C" => Code::KeyC, "D" => Code::KeyD,
        "E" => Code::KeyE, "F" => Code::KeyF, "G" => Code::KeyG, "H" => Code::KeyH,
        "I" => Code::KeyI, "J" => Code::KeyJ, "K" => Code::KeyK, "L" => Code::KeyL,
        "M" => Code::KeyM, "N" => Code::KeyN, "O" => Code::KeyO, "P" => Code::KeyP,
        "Q" => Code::KeyQ, "R" => Code::KeyR, "S" => Code::KeyS, "T" => Code::KeyT,
        "U" => Code::KeyU, "V" => Code::KeyV, "W" => Code::KeyW, "X" => Code::KeyX,
        "Y" => Code::KeyY, "Z" => Code::KeyZ,
        "0" => Code::Digit0, "1" => Code::Digit1, "2" => Code::Digit2, "3" => Code::Digit3,
        "4" => Code::Digit4, "5" => Code::Digit5, "6" => Code::Digit6, "7" => Code::Digit7,
        "8" => Code::Digit8, "9" => Code::Digit9,
        "F1" => Code::F1, "F2" => Code::F2, "F3" => Code::F3, "F4" => Code::F4,
        "F5" => Code::F5, "F6" => Code::F6, "F7" => Code::F7, "F8" => Code::F8,
        "F9" => Code::F9, "F10" => Code::F10, "F11" => Code::F11, "F12" => Code::F12,
        _ => return None,
    })
}

fn register_hotkey(app: &tauri::AppHandle, hotkey: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let sc = parse_hotkey(hotkey).ok_or_else(|| format!("无法识别的快捷键: {hotkey}"))?;
    gs.register(sc).map_err(|e| format!("注册快捷键失败: {e}"))
}

fn apply_autostart(app: &tauri::AppHandle, enable: bool) {
    let mgr = app.autolaunch();
    let enabled = mgr.is_enabled().unwrap_or(false);
    if enable && !enabled { let _ = mgr.enable(); } else if !enable && enabled { let _ = mgr.disable(); }
}

fn hide_panel_internal(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") { let _ = w.hide(); }
}

fn toggle_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) { hide_panel_internal(app); }
        else { let _ = win.show(); let _ = win.set_focus(); let _ = app.emit("panel-shown", ()); }
    }
}

fn apply_window_effect_all(app: &tauri::AppHandle, effect: &str, dark: bool) {
    for label in ["main", "settings"] {
        if let Some(win) = app.get_webview_window(label) { apply_window_effect(&win, effect, dark); }
    }
}

fn apply_window_effect(win: &tauri::WebviewWindow, effect: &str, dark: bool) {
    #[cfg(target_os = "windows")]
    {
        let _ = window_vibrancy::clear_acrylic(win);
        let _ = window_vibrancy::clear_mica(win);
        let _ = window_vibrancy::clear_blur(win);
        match effect {
            "acrylic" => { let color = if dark { (28, 28, 44, 140) } else { (240, 241, 245, 140) }; let _ = window_vibrancy::apply_acrylic(win, Some(color)); }
            "mica" => { let _ = window_vibrancy::apply_mica(win, Some(dark)); }
            "vibrancy" => { let color = if dark { (22, 22, 34, 110) } else { (239, 241, 245, 110) }; let _ = window_vibrancy::apply_blur(win, Some(color)); }
            _ => {}
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = dark;
        let _ = window_vibrancy::clear_vibrancy(win);
        let material = match effect {
            "acrylic" => Some(window_vibrancy::NSVisualEffectMaterial::Sidebar),
            "mica" => Some(window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground),
            "vibrancy" => Some(window_vibrancy::NSVisualEffectMaterial::HudWindow),
            _ => None,
        };
        if let Some(m) = material { let _ = window_vibrancy::apply_vibrancy(win, m, None, Some(10.0)); }
    }
}

pub fn run() {
    let path = data_path();
    let store = load_store(&path);
    let config = load_config();
    let config_state = ConfigState { config: Mutex::new(config.clone()), config_path: config_path(), pinned: AtomicBool::new(false) };
    // 提前拷贝所需配置字段，避免 setup 闭包借用外层局部变量
    let hotkey = config.hotkey.clone();
    let autostart = config.autostart;
    let always_on_top = config.always_on_top;
    let remember_size = config.remember_size;
    let window_width = config.window_width;
    let window_height = config.window_height;
    let silent_start = config.silent_start;
    let theme_dark = config.theme != "light";
    let window_effect_cfg = config.window_effect.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![])))
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _shortcut, event| {
                if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed { toggle_window(app); }
            })
            .build())
        .manage(AppData { store: Mutex::new(store), path })
        .manage(config_state)
        .invoke_handler(tauri::generate_handler![
            list_data, searchable_items, save_item, delete_item, open_item, create_group, rename_group,
            delete_group, save_group_order, save_item_order, unlock_encrypted, reset_password, scan_desktop,
            import_scanned, item_icons, get_config, save_config, get_db_info, export_data, import_data,
            show_panel, hide_panel, set_panel_pinned, get_panel_pinned, set_window_effect, get_config_dir,
            open_settings_window, set_always_on_top
        ])
        .setup(move |app| {
            // 托盘
            let show = MenuItem::with_id(app, "show", "显示/隐藏面板", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let _toggle = CheckMenuItem::with_id(app, "toggle", "钉住面板", true, false, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &settings, &_toggle, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip(format!("速启 ({hotkey})"))
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => toggle_window(app),
                    "settings" => { let _ = open_settings_window_internal(app); }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        toggle_window(tray.app_handle());
                    }
                })
                .build(app)?;
            // 全局热键（默认 Win+`）
            register_hotkey(app.handle(), &hotkey)?;
            // 开机自启
            apply_autostart(app.handle(), autostart);
            // 主窗口配置
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_always_on_top(always_on_top);
                if remember_size && window_width > 0 && window_height > 0 {
                    let _ = win.set_size(tauri::PhysicalSize::new(window_width, window_height));
                }
                apply_window_effect(&win, &window_effect_cfg, theme_dark);
                if silent_start { let _ = win.hide(); }
                let w = win.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        hide_panel_internal(w.app_handle());
                    }
                });
            }
            if let Some(win) = app.get_webview_window("settings") {
                let w = win.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动速启失败");
}
