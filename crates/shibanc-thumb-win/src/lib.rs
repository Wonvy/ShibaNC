//! Windows Explorer Shell Extension (`IThumbnailProvider` + `IInitializeWithStream` + `IInitializeWithFile`)
//! Renders 3D machined `.tap` / `.nc` thumbnails directly inside Windows File Explorer (`dllhost.exe`).

use std::path::{Path, PathBuf};

pub const SHIBANC_THUMB_CLSID_STR: &str = "{8F4B9E3A-6D21-4C8E-9A54-71C2E5F0B108}";
/// Windows Shell standard `IThumbnailProvider` ShellEx handler GUID.
pub const SHELL_THUMBNAIL_HANDLER_GUID: &str = "{e357fccd-a995-4576-b01f-234630154e96}";
pub const SHIBANC_PROG_ID: &str = "ShibaNC.GCodeFile";
pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    ".nc", ".tap", ".gcode", ".cnc", ".ngc", ".anc", ".iso", ".plt", ".mpf",
];

#[cfg(windows)]
mod win_impl {
    use std::ffi::c_void;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;

    use windows::core::{implement, Interface, GUID, HRESULT, PCWSTR};
    use windows::Win32::Foundation::{BOOL, CLASS_E_CLASSNOTAVAILABLE, E_FAIL, E_INVALIDARG, E_POINTER, S_FALSE, S_OK};
    use windows::Win32::Graphics::Gdi::{
        CreateDIBSection, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
    };
    use windows::Win32::System::Com::{
        IClassFactory, IClassFactory_Impl, IStream, STATFLAG_DEFAULT, STATSTG,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::{
        IInitializeWithFile, IInitializeWithFile_Impl, IInitializeWithStream,
        IInitializeWithStream_Impl,
    };
    use windows::Win32::UI::Shell::{
        IThumbnailProvider, IThumbnailProvider_Impl, SHChangeNotify, SHCNE_ASSOCCHANGED,
        SHCNF_IDLIST, WTSAT_ARGB, WTS_ALPHATYPE,
    };
    use winreg::enums::*;
    use winreg::RegKey;

    use super::{
        SHELL_THUMBNAIL_HANDLER_GUID, SHIBANC_PROG_ID, SHIBANC_THUMB_CLSID_STR,
        SUPPORTED_EXTENSIONS,
    };

    pub const CLSID_SHIBANC_THUMB: GUID = GUID::from_u128(0x8f4b9e3a_6d21_4c8e_9a54_71c2e5f0b108);

    static DLL_REF_COUNT: AtomicU32 = AtomicU32::new(0);

    enum SourceData {
        None,
        StreamBytes { bytes: Vec<u8>, ext_hint: String },
        FilePath(PathBuf),
    }

    #[implement(IThumbnailProvider, IInitializeWithStream, IInitializeWithFile)]
    pub struct ShibaThumbnailProvider {
        source: Mutex<SourceData>,
    }

    impl ShibaThumbnailProvider {
        pub fn new() -> Self {
            DLL_REF_COUNT.fetch_add(1, Ordering::Relaxed);
            Self {
                source: Mutex::new(SourceData::None),
            }
        }
    }

    impl Drop for ShibaThumbnailProvider {
        fn drop(&mut self) {
            DLL_REF_COUNT.fetch_sub(1, Ordering::Relaxed);
        }
    }

    impl IInitializeWithStream_Impl for ShibaThumbnailProvider_Impl {
        fn Initialize(&self, pstream: Option<&IStream>, _grfmode: u32) -> windows::core::Result<()> {
            let stream = pstream.ok_or_else(|| windows::core::Error::from(E_INVALIDARG))?;

            // Try reading stream name from STATSTG if available to detect .tap vs .nc extension
            let mut ext_hint = String::from("nc");
            unsafe {
                let mut stat = STATSTG::default();
                if stream.Stat(&mut stat, STATFLAG_DEFAULT).is_ok() && !stat.pwcsName.is_null() {
                    let name = stat.pwcsName.to_string().unwrap_or_default();
                    if let Some(ext) = Path::new(&name).extension() {
                        ext_hint = ext.to_string_lossy().into_owned();
                    }
                    windows::Win32::System::Com::CoTaskMemFree(Some(
                        stat.pwcsName.0 as *const c_void,
                    ));
                }
            }

            // Cap stream read at 128 MB for safety inside Explorer dllhost
            const MAX_STREAM_BYTES: usize = 128 * 1024 * 1024;
            let mut buf = Vec::with_capacity(64 * 1024);
            let mut chunk = [0u8; 65536];
            loop {
                let mut read_bytes: u32 = 0;
                let hr = unsafe {
                    stream.Read(
                        chunk.as_mut_ptr() as *mut c_void,
                        chunk.len() as u32,
                        Some(&mut read_bytes),
                    )
                };
                if hr.is_err() || read_bytes == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..(read_bytes as usize)]);
                if buf.len() >= MAX_STREAM_BYTES {
                    break;
                }
            }

            if let Ok(mut guard) = self.source.lock() {
                *guard = SourceData::StreamBytes {
                    bytes: buf,
                    ext_hint,
                };
            }
            Ok(())
        }
    }

    impl IInitializeWithFile_Impl for ShibaThumbnailProvider_Impl {
        fn Initialize(&self, pszfilepath: &PCWSTR, _grfmode: u32) -> windows::core::Result<()> {
            if pszfilepath.is_null() {
                return Err(windows::core::Error::from(E_INVALIDARG));
            }
            let path_str = unsafe { pszfilepath.to_string() }
                .map_err(|_| windows::core::Error::from(E_INVALIDARG))?;
            if let Ok(mut guard) = self.source.lock() {
                *guard = SourceData::FilePath(PathBuf::from(path_str));
            }
            Ok(())
        }
    }

    impl IThumbnailProvider_Impl for ShibaThumbnailProvider_Impl {
        fn GetThumbnail(
            &self,
            cx: u32,
            phbmp: *mut HBITMAP,
            pdwalpha: *mut WTS_ALPHATYPE,
        ) -> windows::core::Result<()> {
            if phbmp.is_null() || pdwalpha.is_null() {
                return Err(windows::core::Error::from(E_POINTER));
            }

            let size = cx.clamp(96, 1024);
            let guard = self
                .source
                .lock()
                .map_err(|_| windows::core::Error::from(E_FAIL))?;

            let rendered = match &*guard {
                SourceData::StreamBytes { bytes, ext_hint } => {
                    shibanc_render::render_bytes_thumbnail_rgba(bytes, "preview", ext_hint, size)
                }
                SourceData::FilePath(path) => shibanc_render::render_file_thumbnail_rgba(path, size),
                SourceData::None => return Err(windows::core::Error::from(E_FAIL)),
            };
            drop(guard);

            let (w, h, rgba) = rendered.map_err(|_| windows::core::Error::from(E_FAIL))?;
            let hbmp = create_hbitmap_from_rgba(w, h, &rgba)?;

            unsafe {
                *phbmp = hbmp;
                *pdwalpha = WTSAT_ARGB;
            }
            Ok(())
        }
    }

    fn create_hbitmap_from_rgba(w: u32, h: u32, rgba: &[u8]) -> windows::core::Result<HBITMAP> {
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32), // Top-down DIB
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: w * h * 4,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut bits_ptr: *mut c_void = std::ptr::null_mut();
        let hbmp = unsafe { CreateDIBSection(None, &bmi, DIB_RGB_COLORS, &mut bits_ptr, None, 0)? };
        if bits_ptr.is_null() {
            return Err(windows::core::Error::from(E_FAIL));
        }

        let dst = unsafe { std::slice::from_raw_parts_mut(bits_ptr as *mut u8, (w * h * 4) as usize) };
        for (src_px, dst_px) in rgba.chunks_exact(4).zip(dst.chunks_exact_mut(4)) {
            let a = src_px[3] as u32;
            // Premultiplied BGRA for Windows Shell ARGB HBITMAP
            dst_px[0] = ((src_px[2] as u32 * a) / 255) as u8;
            dst_px[1] = ((src_px[1] as u32 * a) / 255) as u8;
            dst_px[2] = ((src_px[0] as u32 * a) / 255) as u8;
            dst_px[3] = src_px[3];
        }
        Ok(hbmp)
    }

    #[implement(IClassFactory)]
    pub struct ShibaClassFactory;

    impl ShibaClassFactory {
        pub fn new() -> Self {
            DLL_REF_COUNT.fetch_add(1, Ordering::Relaxed);
            Self
        }
    }

    impl Drop for ShibaClassFactory {
        fn drop(&mut self) {
            DLL_REF_COUNT.fetch_sub(1, Ordering::Relaxed);
        }
    }

    impl IClassFactory_Impl for ShibaClassFactory_Impl {
        fn CreateInstance(
            &self,
            punkouter: Option<&windows::core::IUnknown>,
            riid: *const GUID,
            ppvobject: *mut *mut c_void,
        ) -> windows::core::Result<()> {
            if ppvobject.is_null() {
                return Err(windows::core::Error::from(E_POINTER));
            }
            unsafe {
                *ppvobject = std::ptr::null_mut();
            }
            if punkouter.is_some() {
                return Err(windows::core::Error::from(
                    windows::Win32::Foundation::CLASS_E_NOAGGREGATION,
                ));
            }
            let provider: IThumbnailProvider = ShibaThumbnailProvider::new().into();
            unsafe { provider.query(riid, ppvobject).ok() }
        }

        fn LockServer(&self, flock: BOOL) -> windows::core::Result<()> {
            if flock.as_bool() {
                DLL_REF_COUNT.fetch_add(1, Ordering::Relaxed);
            } else {
                DLL_REF_COUNT.fetch_sub(1, Ordering::Relaxed);
            }
            Ok(())
        }
    }

    #[no_mangle]
    pub unsafe extern "system" fn DllGetClassObject(
        rclsid: *const GUID,
        riid: *const GUID,
        ppv: *mut *mut c_void,
    ) -> HRESULT {
        if rclsid.is_null() || riid.is_null() || ppv.is_null() {
            return E_POINTER;
        }
        *ppv = std::ptr::null_mut();
        if *rclsid != CLSID_SHIBANC_THUMB {
            return CLASS_E_CLASSNOTAVAILABLE;
        }
        let factory: IClassFactory = ShibaClassFactory::new().into();
        factory.query(riid, ppv)
    }

    #[no_mangle]
    pub unsafe extern "system" fn DllCanUnloadNow() -> HRESULT {
        if DLL_REF_COUNT.load(Ordering::Relaxed) == 0 {
            S_OK
        } else {
            S_FALSE
        }
    }

    pub fn register_user_shell_extension(dll_path: &Path) -> Result<String, String> {
        let dll_abs = dll_path
            .canonicalize()
            .unwrap_or_else(|_| dll_path.to_path_buf());
        // Strip Win32 extended-length `\\?\` prefix because Explorer's COM loader expects standard Win32 paths
        let dll_str = dll_abs
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_string();

        if !Path::new(&dll_str).exists() {
            return Err(format!("找不到缩略图组件 DLL: {}", dll_str));
        }

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let clsid_path = format!(r"Software\Classes\CLSID\{}", SHIBANC_THUMB_CLSID_STR);
        let (clsid_key, _) = hkcu
            .create_subkey(&clsid_path)
            .map_err(|e| format!("注册 CLSID 失败: {}", e))?;
        clsid_key
            .set_value("", &"ShibaNC 3D G-Code Thumbnail Provider")
            .map_err(|e| e.to_string())?;

        let (inproc_key, _) = clsid_key
            .create_subkey("InprocServer32")
            .map_err(|e| format!("创建 InprocServer32 失败: {}", e))?;
        inproc_key
            .set_value("", &dll_str)
            .map_err(|e| e.to_string())?;
        inproc_key
            .set_value("ThreadingModel", &"Both")
            .map_err(|e| e.to_string())?;

        // Register under both `.ext\ShellEx\{e357fccd-...}` AND the mapped ProgID if the user already associated `.tap`/`.nc` with Notepad/VSCode!
        for &ext in SUPPORTED_EXTENSIONS {
            let ext_key_path = format!(r"Software\Classes\{}", ext);
            let (ext_key, _) = hkcu
                .create_subkey(&ext_key_path)
                .map_err(|e| e.to_string())?;

            let shellex_path = format!(r"{}\ShellEx\{}", ext_key_path, SHELL_THUMBNAIL_HANDLER_GUID);
            let (shellex_key, _) = hkcu
                .create_subkey(&shellex_path)
                .map_err(|e| e.to_string())?;
            shellex_key
                .set_value("", &SHIBANC_THUMB_CLSID_STR)
                .map_err(|e| e.to_string())?;

            // Also inspect HKCR\<ext> default ProgID so custom file associations still show ShibaNC thumbnails!
            let hkcr = RegKey::predef(HKEY_CLASSES_ROOT);
            if let Ok(cr_ext) = hkcr.open_subkey(ext) {
                if let Ok(prog_id) = cr_ext.get_value::<String, _>("") {
                    if !prog_id.trim().is_empty() {
                        let prog_shellex = format!(
                            r"Software\Classes\{}\ShellEx\{}",
                            prog_id, SHELL_THUMBNAIL_HANDLER_GUID
                        );
                        if let Ok((pk, _)) = hkcu.create_subkey(&prog_shellex) {
                            let _ = pk.set_value("", &SHIBANC_THUMB_CLSID_STR);
                        }
                    }
                }
            }
            let _ = ext_key.set_value("Content Type", &"application/x-gcode");
        }

        unsafe {
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        }

        Ok(dll_str)
    }

    pub fn unregister_user_shell_extension() -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for &ext in SUPPORTED_EXTENSIONS {
            let shellex_path = format!(
                r"Software\Classes\{}\ShellEx\{}",
                ext, SHELL_THUMBNAIL_HANDLER_GUID
            );
            let _ = hkcu.delete_subkey_all(&shellex_path);
        }
        let clsid_path = format!(r"Software\Classes\CLSID\{}", SHIBANC_THUMB_CLSID_STR);
        let _ = hkcu.delete_subkey_all(&clsid_path);

        unsafe {
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        }
        Ok(())
    }

    pub fn is_registered() -> bool {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let tap_shellex = format!(
            r"Software\Classes\.tap\ShellEx\{}",
            SHELL_THUMBNAIL_HANDLER_GUID
        );
        if let Ok(k) = hkcu.open_subkey(&tap_shellex) {
            if let Ok(val) = k.get_value::<String, _>("") {
                return val.eq_ignore_ascii_case(SHIBANC_THUMB_CLSID_STR);
            }
        }
        false
    }

    pub fn register_user_file_associations(exe_path: &Path) -> Result<String, String> {
        let exe_abs = exe_path
            .canonicalize()
            .unwrap_or_else(|_| exe_path.to_path_buf());
        let exe_str = exe_abs
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_string();

        if !Path::new(&exe_str).exists() {
            return Err(format!("找不到主程序可执行文件: {}", exe_str));
        }

        let open_cmd = format!("\"{}\" \"%1\"", exe_str);
        let icon_spec = format!("\"{}\",0", exe_str);
        let exe_name = Path::new(&exe_str)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "shibanc-app.exe".to_string());

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        // 1. ProgID: HKCU\Software\Classes\ShibaNC.GCodeFile
        let prog_path = format!(r"Software\Classes\{}", SHIBANC_PROG_ID);
        let (prog_k, _) = hkcu.create_subkey(&prog_path).map_err(|e| e.to_string())?;
        prog_k
            .set_value("", &"ShibaNC 三轴 G 代码刀路文件")
            .map_err(|e| e.to_string())?;
        let (icon_k, _) = prog_k.create_subkey("DefaultIcon").map_err(|e| e.to_string())?;
        icon_k.set_value("", &icon_spec).map_err(|e| e.to_string())?;
        let (cmd_k, _) = prog_k
            .create_subkey(r"shell\open\command")
            .map_err(|e| e.to_string())?;
        cmd_k.set_value("", &open_cmd).map_err(|e| e.to_string())?;

        // Preserve thumbnail ShellEx on ShibaNC.GCodeFile if thumbnail provider is registered
        if is_registered() {
            if let Ok((sx_k, _)) =
                prog_k.create_subkey(format!(r"ShellEx\{}", SHELL_THUMBNAIL_HANDLER_GUID))
            {
                let _ = sx_k.set_value("", &SHIBANC_THUMB_CLSID_STR);
            }
        }

        // 2. Applications\<exe_name> for Windows "Open With" dialog
        let app_cls_path = format!(r"Software\Classes\Applications\{}", exe_name);
        if let Ok((app_k, _)) = hkcu.create_subkey(&app_cls_path) {
            let _ = app_k.set_value("FriendlyAppName", &"ShibaNC 刀路三维预览");
            if let Ok((acmd, _)) = app_k.create_subkey(r"shell\open\command") {
                let _ = acmd.set_value("", &open_cmd);
            }
            if let Ok((stypes, _)) = app_k.create_subkey("SupportedTypes") {
                for &ext in SUPPORTED_EXTENSIONS {
                    let _ = stypes.set_value(ext, &"");
                }
            }
        }

        // 3. RegisteredApplications & Capabilities (Windows 10/11 Default Apps integration)
        if let Ok((cap_k, _)) = hkcu.create_subkey(r"Software\ShibaNC\Capabilities") {
            let _ = cap_k.set_value("ApplicationName", &"ShibaNC");
            let _ = cap_k.set_value(
                "ApplicationDescription",
                &"ShibaNC 跨平台三轴 G 代码刀路与实体切削预览工具",
            );
            if let Ok((fa_k, _)) = cap_k.create_subkey("FileAssociations") {
                for &ext in SUPPORTED_EXTENSIONS {
                    let _ = fa_k.set_value(ext, &SHIBANC_PROG_ID);
                }
            }
        }
        if let Ok((reg_apps, _)) = hkcu.create_subkey(r"Software\RegisteredApplications") {
            let _ = reg_apps.set_value("ShibaNC", &"Software\\ShibaNC\\Capabilities");
        }

        // 4. Bind .nc, .tap, .gcode, .cnc -> ShibaNC.GCodeFile + OpenWithProgids
        for &ext in SUPPORTED_EXTENSIONS {
            let ext_path = format!(r"Software\Classes\{}", ext);
            let (ext_k, _) = hkcu.create_subkey(&ext_path).map_err(|e| e.to_string())?;
            ext_k.set_value("", &SHIBANC_PROG_ID).map_err(|e| e.to_string())?;
            let _ = ext_k.set_value("Content Type", &"application/x-gcode");
            if let Ok((ow_k, _)) = ext_k.create_subkey("OpenWithProgids") {
                let _ = ow_k.set_value(SHIBANC_PROG_ID, &"");
            }
        }

        unsafe {
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        }
        Ok(exe_str)
    }

    pub fn unregister_user_file_associations() -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for &ext in SUPPORTED_EXTENSIONS {
            let ext_path = format!(r"Software\Classes\{}", ext);
            if let Ok(ext_k) = hkcu.open_subkey_with_flags(&ext_path, KEY_ALL_ACCESS) {
                if let Ok(cur) = ext_k.get_value::<String, _>("") {
                    if cur == SHIBANC_PROG_ID {
                        let _ = ext_k.delete_value("");
                    }
                }
                if let Ok(ow_k) = ext_k.open_subkey_with_flags("OpenWithProgids", KEY_ALL_ACCESS) {
                    let _ = ow_k.delete_value(SHIBANC_PROG_ID);
                }
            }
        }
        let _ = hkcu.delete_subkey_all(format!(r"Software\Classes\{}", SHIBANC_PROG_ID));
        let _ = hkcu.delete_subkey_all(r"Software\ShibaNC");
        if let Ok(reg_apps) =
            hkcu.open_subkey_with_flags(r"Software\RegisteredApplications", KEY_ALL_ACCESS)
        {
            let _ = reg_apps.delete_value("ShibaNC");
        }

        unsafe {
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        }
        Ok(())
    }

    pub fn is_file_assoc_registered() -> bool {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(k) = hkcu.open_subkey(r"Software\Classes\.tap") {
            if let Ok(val) = k.get_value::<String, _>("") {
                return val == SHIBANC_PROG_ID;
            }
        }
        false
    }
}

/// Locate `shibanc_thumb_win.dll` next to the current executable or target build folder.
pub fn find_companion_dll() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let direct = dir.join("shibanc_thumb_win.dll");
    if direct.exists() {
        return Some(direct);
    }
    // Check workspace target/{release,debug} during local development
    for ancestor in dir.ancestors().take(5) {
        for profile in ["release", "debug"] {
            let cand = ancestor
                .join("target")
                .join(profile)
                .join("shibanc_thumb_win.dll");
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    None
}

pub fn register_os_thumbnails(dll_override: Option<&Path>) -> Result<String, String> {
    #[cfg(windows)]
    {
        let dll = match dll_override {
            Some(p) => p.to_path_buf(),
            None => find_companion_dll().ok_or_else(|| {
                "未找到 shibanc_thumb_win.dll，请先运行 `cargo build --release -p shibanc-thumb-win`".to_string()
            })?,
        };
        win_impl::register_user_shell_extension(&dll)
    }
    #[cfg(not(windows))]
    {
        let _ = dll_override;
        Err("当前非 Windows 平台，请使用 shibanc-cli install-linux-thumbnailer 或 macOS QuickLook 扩展".to_string())
    }
}

pub fn unregister_os_thumbnails() -> Result<(), String> {
    #[cfg(windows)]
    {
        win_impl::unregister_user_shell_extension()
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

pub fn check_os_thumbnails_registered() -> bool {
    #[cfg(windows)]
    {
        win_impl::is_registered()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn register_os_file_associations(exe_override: Option<&Path>) -> Result<String, String> {
    #[cfg(windows)]
    {
        let exe = match exe_override {
            Some(p) => p.to_path_buf(),
            None => std::env::current_exe().map_err(|e| e.to_string())?,
        };
        win_impl::register_user_file_associations(&exe)
    }
    #[cfg(target_os = "linux")]
    {
        let exe = match exe_override {
            Some(p) => p.to_path_buf(),
            None => std::env::current_exe().map_err(|e| e.to_string())?,
        };
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        let apps_dir = Path::new(&home).join(".local/share/applications");
        let _ = std::fs::create_dir_all(&apps_dir);
        let desktop_path = apps_dir.join("shibanc.desktop");
        let desktop_entry = format!(
            "[Desktop Entry]\nType=Application\nName=ShibaNC\nComment=3-Axis CNC G-Code 3D Viewer\nExec=\"{}\" %f\nTerminal=false\nMimeType=application/x-shibanc-gcode;text/x-gcode;application/x-gcode;\nCategories=Graphics;Engineering;\n",
            exe.display()
        );
        std::fs::write(&desktop_path, desktop_entry).map_err(|e| e.to_string())?;
        let _ = std::process::Command::new("xdg-mime")
            .args(["default", "shibanc.desktop", "application/x-shibanc-gcode"])
            .status();
        Ok(desktop_path.to_string_lossy().into_owned())
    }
    #[cfg(all(not(windows), not(target_os = "linux")))]
    {
        let _ = exe_override;
        Ok("macOS 默认通过 ShibaNC.app Info.plist CFBundleDocumentTypes 自动声明 .nc/.tap 打开关联".to_string())
    }
}

pub fn unregister_os_file_associations() -> Result<(), String> {
    #[cfg(windows)]
    {
        win_impl::unregister_user_file_associations()
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

pub fn check_os_file_associations_registered() -> bool {
    #[cfg(windows)]
    {
        win_impl::is_file_assoc_registered()
    }
    #[cfg(not(windows))]
    {
        false
    }
}
