pub mod cpu_fallback;
pub mod headless;
pub mod stl_export;
pub mod types;

use std::path::Path;

use image::{ImageBuffer, Rgba};
use shibanc_gcode::{parse_bytes, parse_file, ParsedProgram};
use thiserror::Error;

pub use headless::{
    global_gpu_engine, HeadlessGpuEngine, RenderError, SIM_SHADER_WGSL, STUDIO_PART_WGSL,
    TOOLPATH_WGSL,
};
pub use stl_export::export_program_binary_stl;
pub use types::{MaterialPreset, RenderOptions};

#[derive(Debug, Error)]
pub enum ThumbnailError {
    #[error("G 代码解析错误: {0}")]
    Gcode(#[from] shibanc_gcode::GcodeError),
    #[error("图片保存错误: {0}")]
    Image(#[from] image::ImageError),
}

/// Render a parsed G-code program into an RGBA8 pixel buffer (uses cached `wgpu` 4x MSAA engine, with automatic CPU SIMD fallback).
pub fn render_program_rgba(program: &ParsedProgram, opts: &RenderOptions, file_ext: &str) -> Vec<u8> {
    if let Some(gpu) = global_gpu_engine() {
        if let Ok(rgba) = gpu.render_program(program, opts, file_ext) {
            return rgba;
        }
    }
    cpu_fallback::render_cpu_fallback(program, opts, file_ext)
}

/// Render an OS file thumbnail (`size x size` RGBA8) directly from a `.tap` or `.nc` file path.
pub fn render_file_thumbnail_rgba(path: &Path, size: u32) -> Result<(u32, u32, Vec<u8>), ThumbnailError> {
    let program = parse_file(path)?;
    let ext = path
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let opts = RenderOptions::for_os_thumbnail(size);
    let rgba = render_program_rgba(&program, &opts, &ext);
    Ok((opts.width, opts.height, rgba))
}

/// Render an OS file thumbnail directly from in-memory bytes (for `IInitializeWithStream` / QuickLook data buffers).
pub fn render_bytes_thumbnail_rgba(
    bytes: &[u8],
    file_name: &str,
    file_ext: &str,
    size: u32,
) -> Result<(u32, u32, Vec<u8>), ThumbnailError> {
    let program = parse_bytes(bytes, file_name, file_ext)?;
    let opts = RenderOptions::for_os_thumbnail(size);
    let rgba = render_program_rgba(&program, &opts, file_ext);
    Ok((opts.width, opts.height, rgba))
}

/// Render a G-code file directly to a PNG file on disk.
pub fn render_file_to_png(
    input_path: &Path,
    output_png: &Path,
    opts: &RenderOptions,
) -> Result<(), ThumbnailError> {
    let program = parse_file(input_path)?;
    let ext = input_path
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let rgba = render_program_rgba(&program, opts, &ext);
    let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(opts.width, opts.height, rgba).expect("valid dimensions");
    img.save(output_png)?;
    Ok(())
}
