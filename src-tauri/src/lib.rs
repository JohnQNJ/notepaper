use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Note {
    id: String,
    title: String,
    content: String,
    updated_at: u64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Todo {
    id: String,
    text: String,
    done: bool,
    created_at: u64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Store {
    notes: Vec<Note>,
    todos: Vec<Todo>,
    active_note: String,
}

/// 用户设置。目录为空字符串表示使用默认位置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    data_dir: String,
    images_dir: String,
    always_on_top: bool,
    theme: String,
    window_material: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            data_dir: String::new(),
            images_dir: String::new(),
            always_on_top: false,
            theme: String::new(),
            window_material: "none".to_string(),
        }
    }
}

/// 上次正常关闭时的窗口位置与内层大小，均使用物理像素。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// 返回给前端的设置，路径均为解析后的绝对路径。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedSettings {
    data_dir: String,
    images_dir: String,
    always_on_top: bool,
    theme: String,
    window_material: String,
}

/// 保存图片的结果。relative 为相对于数据目录的路径（图片在数据目录内时可用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedImage {
    path: String,
    relative: Option<String>,
}

/// 数据目录 themes/*.json 中的主题定义，variables 仅允许白名单 CSS 变量。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ThemeDefinition {
    id: String,
    name: String,
    color_scheme: String,
    variables: HashMap<String, String>,
    #[serde(skip)]
    builtin: bool,
}

const THEME_VARIABLES: &[&str] = &[
    "--plum",
    "--plum-2",
    "--ink",
    "--ink-soft",
    "--line",
    "--card",
    "--stroke",
    "--app-bg",
    "--accent-bar",
    "--surface",
    "--surface-strong",
    "--popover-bg",
    "--shadow",
    "--tint",
    "--tint-strong",
    "--switch-off",
    "--scroll-thumb",
    "--scroll-thumb-hover",
    "--on-ink",
    "--danger",
    "--ui-font",
    "--preview-font",
    "--mono-font",
    "--code-bg",
    "--code-head",
    "--code-text",
    "--token-keyword",
    "--token-string",
    "--token-number",
    "--token-comment",
    "--token-fn",
    "--token-tag",
    "--token-attr",
    "--token-bool",
];

const BUILTIN_THEMES: &[(&str, &str)] = &[
    ("sakura", include_str!("themes/sakura.json")),
    ("midnight", include_str!("themes/midnight.json")),
    ("mint", include_str!("themes/mint.json")),
    ("paper", include_str!("themes/paper.json")),
];

fn app_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|err| err.to_string())
}

fn settings_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("settings.json"))
}

fn read_settings(app: &tauri::AppHandle) -> Settings {
    settings_file(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn window_state_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("window.json"))
}

fn read_window_state(app: &tauri::AppHandle) -> Option<WindowState> {
    let state: WindowState = window_state_file(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())?;
    (state.width > 0 && state.height > 0 && state.width <= 16_384 && state.height <= 16_384)
        .then_some(state)
}

fn window_center_is_visible(window: &tauri::WebviewWindow, state: &WindowState) -> bool {
    let center_x = i64::from(state.x) + i64::from(state.width / 2);
    let center_y = i64::from(state.y) + i64::from(state.height / 2);
    window
        .available_monitors()
        .map(|monitors| {
            monitors.iter().any(|monitor| {
                let origin = monitor.position();
                let size = monitor.size();
                let left = i64::from(origin.x);
                let top = i64::from(origin.y);
                center_x >= left
                    && center_x < left + i64::from(size.width)
                    && center_y >= top
                    && center_y < top + i64::from(size.height)
            })
        })
        .unwrap_or(false)
}

fn restore_window_state(window: &tauri::WebviewWindow) {
    let Some(state) = read_window_state(window.app_handle()) else {
        return;
    };
    if window
        .set_size(tauri::PhysicalSize::new(state.width, state.height))
        .is_err()
    {
        return;
    }
    if window_center_is_visible(window, &state) {
        let _ = window.set_position(tauri::PhysicalPosition::new(state.x, state.y));
    } else {
        // 原显示器可能已断开，保留大小并回到当前可用屏幕中央。
        let _ = window.center();
    }
}

fn save_window_state(window: &tauri::Window) -> Result<(), String> {
    if window.is_minimized().unwrap_or(false) {
        return Ok(());
    }
    let position = window.outer_position().map_err(|err| err.to_string())?;
    let size = window.inner_size().map_err(|err| err.to_string())?;
    if size.width == 0 || size.height == 0 {
        return Ok(());
    }
    let state = WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let path = window_state_file(window.app_handle())?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&state).map_err(|err| err.to_string())?;
    fs::write(path, raw).map_err(|err| format!("保存窗口状态失败：{err}"))
}

fn normalize_window_material(value: &str) -> String {
    match value.trim() {
        "auto" => "auto".to_string(),
        "mica" => "mica".to_string(),
        "acrylic" => "acrylic".to_string(),
        "micaAlt" => "micaAlt".to_string(),
        _ => "none".to_string(),
    }
}

#[cfg(windows)]
mod dwm_material {
    use std::ffi::c_void;

    #[repr(C)]
    #[allow(dead_code)]
    struct OsVersionInfo {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfo) -> i32;
    }

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut c_void,
            attribute: u32,
            value: *const c_void,
            size: u32,
        ) -> i32;
    }

    pub fn build_number() -> u32 {
        let mut info = OsVersionInfo {
            size: std::mem::size_of::<OsVersionInfo>() as u32,
            major: 0,
            minor: 0,
            build: 0,
            platform: 0,
            service_pack: [0; 128],
        };
        let status = unsafe { RtlGetVersion(&mut info) };
        if status == 0 {
            info.build
        } else {
            0
        }
    }

    fn set_attribute(
        window: &tauri::WebviewWindow,
        attribute: u32,
        value: u32,
        name: &str,
    ) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|err| err.to_string())?.0;
        let result = unsafe {
            DwmSetWindowAttribute(
                hwnd,
                attribute,
                &value as *const _ as *const c_void,
                std::mem::size_of::<u32>() as u32,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(format!("设置 DWM {name}失败：HRESULT 0x{:08X}", result))
        }
    }

    pub fn set_backdrop(window: &tauri::WebviewWindow, backdrop: u32) -> Result<(), String> {
        const DWMWA_SYSTEMBACKDROP_TYPE: u32 = 38;
        set_attribute(window, DWMWA_SYSTEMBACKDROP_TYPE, backdrop, "窗口材质")
    }

    pub fn set_dark_mode(window: &tauri::WebviewWindow, dark: bool) -> Result<(), String> {
        const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
        set_attribute(
            window,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            u32::from(dark),
            "窗口明暗",
        )
    }

    pub fn set_rounded_corners(window: &tauri::WebviewWindow) -> Result<(), String> {
        const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
        const DWMWCP_ROUND: u32 = 2;
        set_attribute(
            window,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            DWMWCP_ROUND,
            "窗口圆角",
        )
    }
}

#[cfg(windows)]
fn configure_window_frame(window: &tauri::WebviewWindow) -> Result<(), String> {
    if dwm_material::build_number() >= 22_000 {
        dwm_material::set_rounded_corners(window)?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn configure_window_frame(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

fn theme_uses_dark(data_dir: &Path, theme_id: &str) -> bool {
    let id = if theme_id.trim().is_empty() {
        "sakura"
    } else {
        theme_id.trim()
    };
    read_theme(&data_dir.join("themes").join(format!("{id}.json")))
        .map(|theme| theme.color_scheme == "dark")
        .unwrap_or(false)
}

#[cfg(windows)]
fn apply_window_material(
    window: &tauri::WebviewWindow,
    material: &str,
    dark: bool,
) -> Result<(), String> {
    use tauri::window::{Effect, EffectsBuilder};

    let build = dwm_material::build_number();
    if build >= 22_523 {
        // DWM 材质不会读取 WebView 的 CSS color-scheme，需同步原生窗口明暗。
        dwm_material::set_dark_mode(window, dark)?;
        let backdrop = match material {
            "auto" => 0,
            "mica" => 2,
            "acrylic" => 3,
            "micaAlt" => 4,
            _ => 1,
        };
        return dwm_material::set_backdrop(window, backdrop);
    }

    if material == "none" {
        return window.set_effects(None).map_err(|err| err.to_string());
    }

    let legacy = if build >= 17_763 {
        Effect::Acrylic
    } else {
        Effect::Blur
    };
    let effect = match material {
        "auto" | "mica" | "micaAlt" if build >= 22_000 => Effect::Mica,
        "auto" | "mica" | "micaAlt" => legacy,
        "acrylic" => legacy,
        _ => return Ok(()),
    };
    window
        .set_effects(EffectsBuilder::new().effect(effect).build())
        .map_err(|err| err.to_string())
}

#[cfg(not(windows))]
fn apply_window_material(
    _window: &tauri::WebviewWindow,
    _material: &str,
    _dark: bool,
) -> Result<(), String> {
    Ok(())
}

/// 解析实际使用的目录：默认数据目录为应用数据目录，默认图片目录为 `<数据目录>/images`。
fn resolve_settings(
    app: &tauri::AppHandle,
    settings: &Settings,
) -> Result<(ResolvedSettings, PathBuf, PathBuf), String> {
    let base = app_dir(app)?;
    let data_dir = if settings.data_dir.trim().is_empty() {
        base
    } else {
        PathBuf::from(settings.data_dir.trim())
    };
    let images_dir = if settings.images_dir.trim().is_empty() {
        data_dir.join("images")
    } else {
        PathBuf::from(settings.images_dir.trim())
    };

    let resolved = ResolvedSettings {
        data_dir: data_dir.to_string_lossy().to_string(),
        images_dir: images_dir.to_string_lossy().to_string(),
        always_on_top: settings.always_on_top,
        theme: if settings.theme.trim().is_empty() {
            "sakura".to_string()
        } else {
            settings.theme.trim().to_string()
        },
        window_material: normalize_window_material(&settings.window_material),
    };

    Ok((resolved, data_dir, images_dir))
}

fn write_settings(app: &tauri::AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_file(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    let raw = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    fs::write(&path, raw).map_err(|err| err.to_string())
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Result<ResolvedSettings, String> {
    let settings = read_settings(&app);
    let (resolved, data_dir, images_dir) = resolve_settings(&app, &settings)?;
    fs::create_dir_all(&data_dir).map_err(|err| err.to_string())?;
    fs::create_dir_all(&images_dir).map_err(|err| err.to_string())?;
    ensure_builtin_themes(&data_dir)?;
    Ok(resolved)
}

/// 更新设置。切换数据目录时会把已有的 data.json 复制到新目录（不覆盖已有文件），
/// 随后由前端调用 save_store 把当前内存中的最新内容写入新位置。
#[tauri::command]
fn update_settings(app: tauri::AppHandle, settings: Settings) -> Result<ResolvedSettings, String> {
    let mut next = settings;
    next.data_dir = next.data_dir.trim().to_string();
    next.images_dir = next.images_dir.trim().to_string();
    next.theme = next.theme.trim().to_string();
    next.window_material = normalize_window_material(&next.window_material);

    let current = read_settings(&app);
    let (_, current_data_dir, _) = resolve_settings(&app, &current)?;
    let (resolved, data_dir, images_dir) = resolve_settings(&app, &next)?;

    fs::create_dir_all(&data_dir).map_err(|err| format!("无法创建数据目录：{err}"))?;
    fs::create_dir_all(&images_dir).map_err(|err| format!("无法创建图片目录：{err}"))?;

    // 可以写文件才视为有效目录，避免选中只读位置。
    let probe = data_dir.join(".notepaper-write-test");
    fs::write(&probe, b"ok").map_err(|err| format!("数据目录不可写：{err}"))?;
    let _ = fs::remove_file(&probe);

    if current_data_dir != data_dir {
        let source = current_data_dir.join("data.json");
        let target = data_dir.join("data.json");
        if source.exists() && !target.exists() {
            fs::copy(&source, &target).map_err(|err| format!("迁移数据失败：{err}"))?;
        }
        copy_theme_files(&current_data_dir, &data_dir)?;
    }
    ensure_builtin_themes(&data_dir)?;

    if current.window_material != next.window_material || current.theme != next.theme {
        if let Some(window) = app.get_webview_window("main") {
            let dark = theme_uses_dark(&data_dir, &resolved.theme);
            apply_window_material(&window, &next.window_material, dark)?;
        }
    }
    write_settings(&app, &next)?;
    Ok(resolved)
}

fn validate_theme(mut theme: ThemeDefinition) -> Result<ThemeDefinition, String> {
    theme.id = theme.id.trim().to_string();
    theme.name = theme.name.trim().to_string();
    theme.color_scheme = theme.color_scheme.trim().to_ascii_lowercase();
    if theme.color_scheme.is_empty() {
        theme.color_scheme = "light".to_string();
    }

    let mut chars = theme.id.chars();
    let valid_first = chars
        .next()
        .map(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        .unwrap_or(false);
    if !valid_first
        || theme.id.len() > 40
        || !theme
            .id
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_')
    {
        return Err("id 需为 1–40 位小写字母、数字、- 或 _，且以字母或数字开头".to_string());
    }
    if theme.name.is_empty() || theme.name.chars().count() > 40 {
        return Err("name 不能为空且不能超过 40 个字符".to_string());
    }
    if theme.color_scheme != "light" && theme.color_scheme != "dark" {
        return Err("colorScheme 只能是 light 或 dark".to_string());
    }
    if theme.variables.is_empty() {
        return Err("variables 至少需要一个 CSS 变量".to_string());
    }

    let mut variables = HashMap::new();
    for (key, value) in theme.variables {
        if !THEME_VARIABLES.contains(&key.as_str()) {
            return Err(format!("不支持的 CSS 变量：{key}"));
        }
        let value = value.trim().to_string();
        let lower = value.to_ascii_lowercase();
        if value.is_empty()
            || value.len() > 1000
            || value.chars().any(|ch| ch.is_control())
            || value.contains(['{', '}', ';', '<', '>'])
            || lower.contains("url(")
            || lower.contains("expression(")
            || lower.contains("@import")
            || lower.contains("javascript:")
        {
            return Err(format!("变量 {key} 的值无效"));
        }
        variables.insert(key, value);
    }
    theme.variables = variables;
    Ok(theme)
}

fn read_theme(path: &Path) -> Result<ThemeDefinition, String> {
    let size = fs::metadata(path).map_err(|err| err.to_string())?.len();
    if size > 128 * 1024 {
        return Err("主题文件不能超过 128KB".to_string());
    }
    let raw = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let theme: ThemeDefinition =
        serde_json::from_str(&raw).map_err(|err| format!("主题 JSON 格式错误：{err}"))?;
    validate_theme(theme)
}

fn ensure_builtin_themes(data_dir: &Path) -> Result<PathBuf, String> {
    let dir = data_dir.join("themes");
    fs::create_dir_all(&dir).map_err(|err| format!("无法创建主题目录：{err}"))?;
    for (id, raw) in BUILTIN_THEMES {
        let path = dir.join(format!("{id}.json"));
        if !path.exists() {
            fs::write(&path, raw).map_err(|err| format!("写入内置主题失败：{err}"))?;
        }
    }
    Ok(dir)
}

fn copy_theme_files(source_dir: &Path, target_dir: &Path) -> Result<(), String> {
    let source = source_dir.join("themes");
    if !source.is_dir() || source_dir == target_dir {
        return Ok(());
    }
    let target = target_dir.join("themes");
    fs::create_dir_all(&target).map_err(|err| err.to_string())?;
    for entry in fs::read_dir(&source).map_err(|err| err.to_string())? {
        let path = entry.map_err(|err| err.to_string())?.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") || !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name() else {
            continue;
        };
        let target_file = target.join(name);
        if !target_file.exists() {
            fs::copy(&path, &target_file).map_err(|err| format!("迁移主题失败：{err}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn list_themes(app: tauri::AppHandle) -> Result<Vec<ThemeDefinition>, String> {
    let settings = read_settings(&app);
    let (_, data_dir, _) = resolve_settings(&app, &settings)?;
    let dir = ensure_builtin_themes(&data_dir)?;
    let mut themes = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|err| err.to_string())? {
        let path = entry.map_err(|err| err.to_string())?.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") || !path.is_file() {
            continue;
        }
        let mut theme =
            read_theme(&path).map_err(|err| format!("主题文件 {} 无效：{err}", path.display()))?;
        let file_id = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("");
        if file_id != theme.id {
            return Err(format!("主题文件名应与 id 一致：{}", path.display()));
        }
        theme.builtin = BUILTIN_THEMES.iter().any(|(id, _)| *id == theme.id);
        themes.push(theme);
    }
    themes.sort_by(|a, b| {
        let order = |id: &str| {
            BUILTIN_THEMES
                .iter()
                .position(|(builtin, _)| *builtin == id)
                .unwrap_or(usize::MAX)
        };
        order(&a.id)
            .cmp(&order(&b.id))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(themes)
}

#[tauri::command]
fn export_theme(app: tauri::AppHandle, id: String, target: String) -> Result<String, String> {
    let theme = list_themes(app)?
        .into_iter()
        .find(|theme| theme.id == id.trim())
        .ok_or_else(|| "主题不存在".to_string())?;
    let raw = serde_json::to_string_pretty(&theme).map_err(|err| err.to_string())?;
    let target_path = PathBuf::from(target);
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(&target_path, raw).map_err(|err| format!("导出主题失败：{err}"))?;
    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
fn import_theme(app: tauri::AppHandle, source: String) -> Result<ThemeDefinition, String> {
    let source_path = PathBuf::from(source);
    let theme = read_theme(&source_path)?;
    let settings = read_settings(&app);
    let (_, data_dir, _) = resolve_settings(&app, &settings)?;
    let dir = ensure_builtin_themes(&data_dir)?;
    let raw = serde_json::to_string_pretty(&theme).map_err(|err| err.to_string())?;
    let target = dir.join(format!("{}.json", theme.id));
    fs::write(&target, raw).map_err(|err| format!("导入主题失败：{err}"))?;
    Ok(theme)
}

#[tauri::command]
async fn pick_theme_target(default_name: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("导出主题")
            .add_filter("JSON 主题", &["json"])
            .set_file_name(&default_name)
            .save_file()
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
async fn pick_theme_file() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("导入主题")
            .add_filter("JSON 主题", &["json"])
            .pick_file()
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
async fn pick_folder() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择目录")
            .pick_folder()
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err("目录不存在".to_string());
    }

    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(&target).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&target).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&target).spawn();

    result.map(|_| ()).map_err(|err| err.to_string())
}

#[tauri::command]
fn load_store(app: tauri::AppHandle) -> Result<Store, String> {
    let settings = read_settings(&app);
    let (_, data_dir, _) = resolve_settings(&app, &settings)?;
    let path = data_dir.join("data.json");
    if !path.exists() {
        return Ok(Store::default());
    }
    let raw = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    serde_json::from_str(&raw).map_err(|err| err.to_string())
}

#[tauri::command]
fn save_store(app: tauri::AppHandle, store: Store) -> Result<(), String> {
    let settings = read_settings(&app);
    let (_, data_dir, _) = resolve_settings(&app, &settings)?;
    fs::create_dir_all(&data_dir).map_err(|err| err.to_string())?;
    let path = data_dir.join("data.json");
    let raw = serde_json::to_string_pretty(&store).map_err(|err| err.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw).map_err(|err| err.to_string())?;
    fs::rename(&tmp, &path).map_err(|err| err.to_string())?;
    Ok(())
}

/// 把前端传来的 PNG base64 落到图片目录，返回绝对路径与相对数据目录的路径。
#[tauri::command]
fn save_image(app: tauri::AppHandle, data: String) -> Result<SavedImage, String> {
    let settings = read_settings(&app);
    let (_, data_dir, images_dir) = resolve_settings(&app, &settings)?;
    fs::create_dir_all(&images_dir).map_err(|err| err.to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|err| err.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_millis();
    let path = images_dir.join(format!("img_{stamp}.png"));
    fs::write(&path, bytes).map_err(|err| err.to_string())?;

    let relative = path
        .strip_prefix(&data_dir)
        .ok()
        .map(|rest| rest.to_string_lossy().replace('\\', "/"));

    Ok(SavedImage {
        path: path.to_string_lossy().to_string(),
        relative,
    })
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn is_relative_image_ref(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    if lower.starts_with("http:")
        || lower.starts_with("https:")
        || lower.starts_with("data:")
        || lower.starts_with("asset:")
        || lower.starts_with("notepaper:")
        || lower.starts_with("file:")
    {
        return false;
    }
    if value.starts_with("//") || value.starts_with('\\') || value.starts_with('/') {
        return false;
    }
    // Windows 盘符绝对路径
    let bytes = value.as_bytes();
    if bytes.len() > 2 && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/') {
        return false;
    }
    true
}

/// 从所有笔记中提取引用到的相对图片路径，用于加入备份包。
fn referenced_relative_images(store: &Store) -> Vec<String> {
    let mut refs = HashSet::new();
    for note in &store.notes {
        let mut rest = note.content.as_str();
        while let Some(start) = rest.find("](") {
            let after = &rest[start + 2..];
            let Some(end) = after.find(')') else {
                break;
            };
            let candidate = after[..end]
                .trim()
                .trim_start_matches('<')
                .trim_end_matches('>');
            if is_relative_image_ref(candidate) && !candidate.contains("..") {
                refs.insert(candidate.replace('\\', "/"));
            }
            rest = &after[end + 1..];
        }
    }
    let mut list: Vec<String> = refs.into_iter().collect();
    list.sort();
    list
}

fn collect_dir_files(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let archive_name = format!("{prefix}/{name}");
        if path.is_dir() {
            collect_dir_files(&path, &archive_name, out);
        } else if path.is_file() {
            out.push((archive_name, path));
        }
    }
}

/// 把 data.json、图片目录以及笔记中引用的相对图片打包成 zip 备份。
#[tauri::command]
fn export_backup(app: tauri::AppHandle, target: String) -> Result<String, String> {
    let settings = read_settings(&app);
    let (_, data_dir, images_dir) = resolve_settings(&app, &settings)?;
    let themes_dir = ensure_builtin_themes(&data_dir)?;
    let data_file = data_dir.join("data.json");
    if !data_file.exists() {
        return Err("还没有可备份的数据".to_string());
    }
    let raw = fs::read_to_string(&data_file).map_err(|err| err.to_string())?;
    let store: Store = serde_json::from_str(&raw).map_err(|err| format!("数据文件损坏：{err}"))?;

    let target_path = PathBuf::from(&target);
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let file = fs::File::create(&target_path).map_err(|err| format!("无法创建备份文件：{err}"))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut added: HashSet<String> = HashSet::new();

    writer
        .start_file("data.json", options)
        .map_err(|err| err.to_string())?;
    writer
        .write_all(raw.as_bytes())
        .map_err(|err| err.to_string())?;
    added.insert("data.json".to_string());

    let manifest = format!(
        "{{\n  \"app\": \"notepaper\",\n  \"version\": \"{}\",\n  \"exportedAt\": {}\n}}\n",
        env!("CARGO_PKG_VERSION"),
        now_millis()
    );
    writer
        .start_file("manifest.json", options)
        .map_err(|err| err.to_string())?;
    writer
        .write_all(manifest.as_bytes())
        .map_err(|err| err.to_string())?;

    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_dir_files(&themes_dir, "themes", &mut files);
    if images_dir != data_dir && images_dir.starts_with(&data_dir) {
        let prefix = images_dir
            .strip_prefix(&data_dir)
            .unwrap_or(Path::new("images"))
            .to_string_lossy()
            .replace('\\', "/");
        collect_dir_files(&images_dir, &prefix, &mut files);
    }
    for rel in referenced_relative_images(&store) {
        if files.iter().any(|(name, _)| name == &rel) {
            continue;
        }
        let path = data_dir.join(&rel);
        if path.is_file() {
            files.push((rel, path));
        }
    }

    for (name, path) in files {
        if !added.insert(name.clone()) {
            continue;
        }
        writer
            .start_file(&name, options)
            .map_err(|err| err.to_string())?;
        let bytes = fs::read(&path).map_err(|err| err.to_string())?;
        writer.write_all(&bytes).map_err(|err| err.to_string())?;
    }

    writer.finish().map_err(|err| err.to_string())?;
    Ok(target_path.to_string_lossy().to_string())
}

/// 从 zip 备份恢复数据到当前数据目录。导入前保留 data.json.bak。
#[tauri::command]
fn import_backup(app: tauri::AppHandle, source: String) -> Result<usize, String> {
    let settings = read_settings(&app);
    let (_, data_dir, _) = resolve_settings(&app, &settings)?;

    let file = fs::File::open(&source).map_err(|err| format!("无法打开备份：{err}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|err| format!("不是有效的 zip 备份：{err}"))?;

    let mut data_bytes: Option<Vec<u8>> = None;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|err| err.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        if name.to_string_lossy().replace('\\', "/") == "data.json" {
            let mut buffer = Vec::new();
            entry
                .read_to_end(&mut buffer)
                .map_err(|err| err.to_string())?;
            data_bytes = Some(buffer);
            break;
        }
    }

    let data_bytes = data_bytes.ok_or_else(|| "备份中缺少 data.json".to_string())?;
    serde_json::from_slice::<Store>(&data_bytes)
        .map_err(|err| format!("备份数据格式错误：{err}"))?;

    fs::create_dir_all(&data_dir).map_err(|err| err.to_string())?;
    let data_file = data_dir.join("data.json");
    if data_file.exists() {
        let _ = fs::copy(&data_file, data_dir.join("data.json.bak"));
    }

    let mut count = 0usize;
    let mut total_bytes: u64 = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|err| err.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        if name.to_string_lossy().replace('\\', "/") == "manifest.json" {
            continue;
        }
        total_bytes += entry.size();
        if total_bytes > 1024 * 1024 * 1024 {
            return Err("备份内容过大，已中止导入".to_string());
        }
        let target = data_dir.join(&name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let mut output = fs::File::create(&target).map_err(|err| format!("写入失败：{err}"))?;
        std::io::copy(&mut entry, &mut output).map_err(|err| err.to_string())?;
        count += 1;
    }

    ensure_builtin_themes(&data_dir)?;
    Ok(count)
}

#[tauri::command]
async fn pick_backup_target(default_name: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("导出备份")
            .add_filter("ZIP 备份", &["zip"])
            .set_file_name(&default_name)
            .save_file()
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
async fn pick_backup_file() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择备份文件")
            .add_filter("ZIP 备份", &["zip"])
            .pick_file()
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| err.to_string())
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn not_found() -> tauri::http::Response<Cow<'static, [u8]>> {
    tauri::http::Response::builder()
        .status(404)
        .body(Cow::Owned(Vec::new()))
        .unwrap_or_else(|_| tauri::http::Response::new(Cow::Owned(Vec::new())))
}

/// 自定义 `notepaper://` 协议：按绝对路径读取图片，
/// 这样图片目录可以放在任意磁盘位置，不受 asset 协议 scope 限制。
fn serve_local_file(
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    let encoded = request.uri().path().trim_start_matches('/');
    let decoded = percent_decode_str(encoded).decode_utf8_lossy().to_string();
    let path = PathBuf::from(decoded);

    match fs::read(&path) {
        Ok(bytes) => tauri::http::Response::builder()
            .header(tauri::http::header::CONTENT_TYPE, mime_for(&path))
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "no-cache")
            .body(Cow::Owned(bytes))
            .unwrap_or_else(|_| not_found()),
        Err(_) => not_found(),
    }
}

pub fn run() {
    tauri::Builder::default()
        .register_uri_scheme_protocol("notepaper", |_ctx, request| serve_local_file(request))
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                restore_window_state(&window);
                if let Err(error) = configure_window_frame(&window) {
                    eprintln!("应用窗口圆角失败：{error}");
                }
                let settings = read_settings(app.handle());
                let dark = resolve_settings(app.handle(), &settings)
                    .map(|(resolved, data_dir, _)| theme_uses_dark(&data_dir, &resolved.theme))
                    .unwrap_or(false);
                if let Err(error) = apply_window_material(&window, &settings.window_material, dark)
                {
                    eprintln!("应用窗口材质失败：{error}");
                }
                if settings.always_on_top {
                    let _ = window.set_always_on_top(true);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Err(error) = save_window_state(window) {
                    eprintln!("{error}");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            list_themes,
            export_theme,
            import_theme,
            pick_theme_target,
            pick_theme_file,
            pick_folder,
            open_folder,
            load_store,
            save_store,
            save_image,
            export_backup,
            import_backup,
            pick_backup_target,
            pick_backup_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running notepaper");
}
