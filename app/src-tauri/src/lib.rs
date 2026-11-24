use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use image::{ImageBuffer, ImageFormat, Rgba};
use serde::Serialize;
use shibanc_gcode::{
    generate_mechanical_nc_sample, generate_relief_tap_sample, parse_bytes, parse_file,
    ParsedProgram, StockSpec, ToolKind, ToolSpec, ToolpathStats,
};
use shibanc_render::{
    export_program_binary_stl, render_program_rgba, MaterialPreset, RenderOptions, SIM_SHADER_WGSL,
    STUDIO_PART_WGSL, TOOLPATH_WGSL,
};
use tauri::ipc::Response;
use tauri::{Manager, State};

struct AppState {
    session: Mutex<Option<LoadedSession>>,
}

struct LoadedSession {
    program: ParsedProgram,
    file_ext: String,
}

#[derive(Serialize)]
pub struct ShadersDto {
    pub sim_wgsl: &'static str,
    pub studio_part_wgsl: &'static str,
    pub toolpath_wgsl: &'static str,
}

#[derive(Serialize)]
pub struct ProgramPayloadDto {
    pub stats: ToolpathStats,
    pub stock: StockSpec,
    pub tool: ToolSpec,
    pub default_material_id: u32,
    pub preview_lines: Vec<String>,
}

fn build_payload(program: &ParsedProgram, ext: &str) -> ProgramPayloadDto {
    let default_mat = MaterialPreset::auto_for_tool(program.tool.kind, ext);
    ProgramPayloadDto {
        stats: program.stats.clone(),
        stock: program.stock,
        tool: program.tool.clone(),
        default_material_id: default_mat.id(),
        preview_lines: program.preview_lines.clone(),
    }
}

#[tauri::command]
fn get_wgsl_shaders() -> ShadersDto {
    ShadersDto {
        sim_wgsl: SIM_SHADER_WGSL,
        studio_part_wgsl: STUDIO_PART_WGSL,
        toolpath_wgsl: TOOLPATH_WGSL,
    }
}

#[derive(Serialize)]
pub struct FolderFileEntryDto {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub ext: String,
}

fn is_supported_gcode_ext(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    if matches!(ext.as_str(), "tap" | "nc" | "gcode" | "cnc") {
        Some(ext)
    } else {
        None
    }
}

fn collect_gcode_files_in_dir(dir: &Path, max_depth: usize, out: &mut Vec<FolderFileEntryDto>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut subdirs: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if let Ok(ft) = entry.file_type() {
            if ft.is_file() {
                if let Some(ext) = is_supported_gcode_ext(&p) {
                    let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    let name = p
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    out.push(FolderFileEntryDto {
                        name,
                        path: p.to_string_lossy().into_owned(),
                        size_bytes,
                        ext,
                    });
                }
            } else if ft.is_dir() && max_depth > 0 {
                subdirs.push(p);
            }
        }
    }
    for sd in subdirs {
        collect_gcode_files_in_dir(&sd, max_depth - 1, out);
    }
}

#[tauri::command]
fn scan_gcode_folder(folder_path: String) -> Result<Vec<FolderFileEntryDto>, String> {
    let p = Path::new(&folder_path);
    if !p.exists() {
        return Err(format!("路径不存在: {}", folder_path));
    }
    let root = if p.is_file() {
        p.parent().unwrap_or(p)
    } else {
        p
    };
    let mut files = Vec::new();
    collect_gcode_files_in_dir(root, 2, &mut files);
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(files)
}

#[tauri::command]
fn is_directory_path(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
fn get_startup_file_arg() -> Option<String> {
    std::env::args().skip(1).find(|arg| {
        let p = Path::new(arg);
        if p.is_dir() {
            return true;
        }
        let lower = arg.to_ascii_lowercase();
        lower.ends_with(".tap")
            || lower.ends_with(".nc")
            || lower.ends_with(".gcode")
            || lower.ends_with(".cnc")
    })
}

#[tauri::command]
fn load_gcode_from_path(
    path: String,
    state: State<'_, AppState>,
) -> Result<ProgramPayloadDto, String> {
    let p = Path::new(&path);
    let program = parse_file(p).map_err(|e| e.to_string())?;
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "nc".to_string());
    let dto = build_payload(&program, &ext);
    let mut guard = state.session.lock().map_err(|_| "状态锁繁忙".to_string())?;
    *guard = Some(LoadedSession {
        program,
        file_ext: ext,
    });
    Ok(dto)
}

#[tauri::command]
fn load_builtin_sample(
    sample_kind: String,
    state: State<'_, AppState>,
) -> Result<ProgramPayloadDto, String> {
    let (content, name, ext) = if sample_kind == "mechanical_nc" {
        (
            generate_mechanical_nc_sample(),
            "aerospace_bearing_housing.nc",
            "nc",
        )
    } else {
        (
            generate_relief_tap_sample(),
            "lotus_relief_medallion.tap",
            "tap",
        )
    };
    let program = parse_bytes(content.as_bytes(), name, ext).map_err(|e| e.to_string())?;
    let dto = build_payload(&program, ext);
    let mut guard = state.session.lock().map_err(|_| "状态锁繁忙".to_string())?;
    *guard = Some(LoadedSession {
        program,
        file_ext: ext.to_string(),
    });
    Ok(dto)
}

/// Zero-JSON raw binary IPC transfer of `GpuSegment[]` directly to WebGPU VRAM!
#[tauri::command]
fn get_segments_binary(state: State<'_, AppState>) -> Result<Response, String> {
    let guard = state.session.lock().map_err(|_| "状态锁繁忙".to_string())?;
    let Some(sess) = guard.as_ref() else {
        return Ok(Response::new(Vec::<u8>::new()));
    };
    let raw_bytes: &[u8] = bytemuck::cast_slice(&sess.program.segments);
    Ok(Response::new(raw_bytes.to_vec()))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn export_hd_render_png(
    output_path: String,
    width: u32,
    height: u32,
    grid_max_dim: u32,
    material_id: u32,
    stock_min: [f32; 3],
    stock_max: [f32; 3],
    tool_kind_code: u32,
    tool_diameter: f32,
    tool_tip_radius: f32,
    tool_half_angle_deg: f32,
    yaw_deg: f32,
    pitch_deg: f32,
    zoom: f32,
    show_cuts: bool,
    show_rapids: bool,
    show_cutter: bool,
    show_solid: bool,
    active_segments: Option<usize>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.session.lock().map_err(|_| "状态锁繁忙".to_string())?;
    let sess = guard.as_ref().ok_or_else(|| "尚未加载刀路文件".to_string())?;

    let mut prog_clone = sess.program.clone();
    prog_clone.stock.min = stock_min;
    prog_clone.stock.max = [
        stock_max[0].max(stock_min[0] + 0.5),
        stock_max[1].max(stock_min[1] + 0.5),
        stock_max[2].max(stock_min[2] + 0.1),
    ];
    prog_clone.tool.kind = ToolKind::from_code(tool_kind_code);
    prog_clone.tool.diameter = tool_diameter.max(0.1);
    prog_clone.tool.tip_radius = tool_tip_radius.max(0.0);
    prog_clone.tool.half_angle_deg = tool_half_angle_deg.clamp(0.0, 85.0);

    let opts = RenderOptions {
        width: width.clamp(256, 4096),
        height: height.clamp(256, 4096),
        grid_max_dim: grid_max_dim.clamp(256, 2048),
        material: Some(MaterialPreset::from_id(material_id)),
        show_cuts_overlay: show_cuts,
        show_rapids_overlay: show_rapids,
        show_cutter,
        show_floor: true,
        show_solid,
        yaw_deg,
        pitch_deg,
        zoom,
        active_segments,
    };

    let rgba = render_program_rgba(&prog_clone, &opts, &sess.file_ext);
    let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(opts.width, opts.height, rgba).ok_or("图像缓冲尺寸无效")?;
    img.save(Path::new(&output_path))
        .map_err(|e| format!("保存 PNG 失败: {}", e))?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn export_stl_model(
    output_path: String,
    grid_max_dim: u32,
    stock_min: [f32; 3],
    stock_max: [f32; 3],
    tool_kind_code: u32,
    tool_diameter: f32,
    tool_tip_radius: f32,
    tool_half_angle_deg: f32,
    active_segments: Option<usize>,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    let guard = state.session.lock().map_err(|_| "状态锁繁忙".to_string())?;
    let sess = guard.as_ref().ok_or_else(|| "尚未加载刀路文件".to_string())?;

    let mut prog_clone = sess.program.clone();
    prog_clone.stock.min = stock_min;
    prog_clone.stock.max = [
        stock_max[0].max(stock_min[0] + 0.5),
        stock_max[1].max(stock_min[1] + 0.5),
        stock_max[2].max(stock_min[2] + 0.1),
    ];
    prog_clone.tool.kind = ToolKind::from_code(tool_kind_code);
    prog_clone.tool.diameter = tool_diameter.max(0.1);
    prog_clone.tool.tip_radius = tool_tip_radius.max(0.0);
    prog_clone.tool.half_angle_deg = tool_half_angle_deg.clamp(0.0, 85.0);

    export_program_binary_stl(
        &prog_clone,
        grid_max_dim.clamp(256, 1536),
        active_segments,
        Path::new(&output_path),
    )
}

#[tauri::command]
fn render_gcode_card_png(path: String, dark_mode: bool) -> Result<Response, String> {
    let p = Path::new(&path);
    let program = parse_file(p).map_err(|e| e.to_string())?;
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "nc".to_string());

    let mut opts = RenderOptions::for_os_thumbnail(320);
    opts.width = 320;
    opts.height = 200;
    opts.grid_max_dim = 320;
    opts.show_floor = dark_mode;
    opts.zoom = 1.15;

    let rgba = render_program_rgba(&program, &opts, &ext);
    let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(opts.width, opts.height, rgba).ok_or("缩略图尺寸无效")?;
    let mut png_bytes: Vec<u8> = Vec::with_capacity(32 * 1024);
    img.write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(Response::new(png_bytes))
}

#[tauri::command]
fn get_os_thumbnail_status() -> bool {
    shibanc_thumb_win::check_os_thumbnails_registered()
}

#[tauri::command]
fn toggle_os_thumbnails(enable: bool) -> Result<String, String> {
    if enable {
        let dll_path = shibanc_thumb_win::register_os_thumbnails(None)?;
        Ok(format!("已启用资源管理器 .tap/.nc 3D 缩略图 ({})", dll_path))
    } else {
        shibanc_thumb_win::unregister_os_thumbnails()?;
        Ok("已关闭资源管理器 .tap/.nc 缩略图扩展".to_string())
    }
}

#[tauri::command]
fn get_file_association_status() -> bool {
    shibanc_thumb_win::check_os_file_associations_registered()
}

#[tauri::command]
fn toggle_file_associations(enable: bool) -> Result<String, String> {
    if enable {
        let exe_path = shibanc_thumb_win::register_os_file_associations(None)?;
        Ok(format!("已将 ShibaNC 设为 .nc / .tap 默认打开程序 ({})", exe_path))
    } else {
        shibanc_thumb_win::unregister_os_file_associations()?;
        Ok("已取消 .nc / .tap 默认打开关联".to_string())
    }
}

#[tauri::command]
fn save_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content.as_bytes()).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

fn detect_os_is_chinese() -> bool {
    #[cfg(target_os = "windows")]
    {
        extern "system" {
            fn GetUserDefaultUILanguage() -> u16;
        }
        // Primary LANGID 0x04 = LANG_CHINESE (zh-CN, zh-TW, zh-HK, zh-SG)
        let lang_id = unsafe { GetUserDefaultUILanguage() };
        if (lang_id & 0x3ff) == 0x04 {
            return true;
        }
    }
    for var in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(val) = std::env::var(var) {
            if val.to_ascii_lowercase().starts_with("zh") {
                return true;
            }
        }
    }
    false
}

#[tauri::command]
fn get_system_locale() -> &'static str {
    if detect_os_is_chinese() {
        "zh-CN"
    } else {
        "en"
    }
}

#[tauri::command]
fn get_app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only https:// URLs are permitted".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            if detect_os_is_chinese() {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_title("ShibaNC — 高清三轴 G 代码刀路与实体切削仿真");
                }
            }
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let _ = app
                    .handle()
                    .plugin(tauri_plugin_updater::Builder::new().build());
            }
            Ok(())
        })
        .manage(AppState {
            session: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_wgsl_shaders,
            get_startup_file_arg,
            scan_gcode_folder,
            is_directory_path,
            load_gcode_from_path,
            load_builtin_sample,
            get_segments_binary,
            export_hd_render_png,
            export_stl_model,
            render_gcode_card_png,
            get_os_thumbnail_status,
            toggle_os_thumbnails,
            get_file_association_status,
            toggle_file_associations,
            save_text_file,
            read_text_file,
            get_app_version,
            get_system_locale,
            open_external_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ShibaNC application");
}
