//! C-FFI bridge for macOS QuickLook (`QLThumbnailProvider` / `QLPreviewProvider`) and external native hosts.

use std::ffi::CStr;
use std::os::raw::c_char;
use std::path::Path;

#[repr(C)]
pub struct ShibaRgbaBuffer {
    pub data: *mut u8,
    pub len: usize,
    pub width: u32,
    pub height: u32,
}

/// Render a `.tap` or `.nc` file at `path_utf8` into an RGBA8 buffer of `max_size x max_size`.
/// Returns `true` on success; caller must release `out_buf` with `shibanc_free_rgba_buffer`.
#[no_mangle]
pub unsafe extern "C" fn shibanc_render_file_thumbnail(
    path_utf8: *const c_char,
    max_size: u32,
    out_buf: *mut ShibaRgbaBuffer,
) -> bool {
    if path_utf8.is_null() || out_buf.is_null() {
        return false;
    }
    let Ok(c_str) = CStr::from_ptr(path_utf8).to_str() else {
        return false;
    };
    let Ok((w, h, rgba)) = shibanc_render::render_file_thumbnail_rgba(Path::new(c_str), max_size) else {
        return false;
    };
    let mut boxed = rgba.into_boxed_slice();
    let len = boxed.len();
    let ptr = boxed.as_mut_ptr();
    std::mem::forget(boxed);

    *out_buf = ShibaRgbaBuffer {
        data: ptr,
        len,
        width: w,
        height: h,
    };
    true
}

#[no_mangle]
pub unsafe extern "C" fn shibanc_free_rgba_buffer(buf: ShibaRgbaBuffer) {
    if !buf.data.is_null() && buf.len > 0 {
        let slice = std::slice::from_raw_parts_mut(buf.data, buf.len);
        drop(Box::from_raw(slice as *mut [u8]));
    }
}
