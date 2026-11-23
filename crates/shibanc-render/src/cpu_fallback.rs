//! Multi-threaded CPU heightfield + studio normal shader fallback for restricted OS sandboxes without GPU access.

use glam::{Mat4, Vec3, Vec4};
use rayon::prelude::*;
use shibanc_gcode::ParsedProgram;

use crate::types::{MaterialPreset, RenderOptions};

pub fn render_cpu_fallback(program: &ParsedProgram, opts: &RenderOptions, file_ext: &str) -> Vec<u8> {
    let w = opts.width.max(32) as usize;
    let h = opts.height.max(32) as usize;
    let stock = &program.stock;
    let tool = &program.tool;
    let size = stock.size();

    let max_dim = opts.grid_max_dim.clamp(128, 512) as f32;
    let scale = max_dim / size[0].max(size[1]).max(1.0);
    let gw = ((size[0] * scale).round() as usize).clamp(64, 512);
    let gh = ((size[1] * scale).round() as usize).clamp(64, 512);
    let dx = size[0] / ((gw - 1) as f32);
    let dy = size[1] / ((gh - 1) as f32);

    let mut grid = vec![stock.max[2]; gw * gh];
    let outer_r = (tool.diameter * 0.5).max(0.05);
    let r2 = outer_r * outer_r;
    let active = opts.active_segments.unwrap_or(program.segments.len()).min(program.segments.len());

    for seg in &program.segments[..active] {
        if !seg.is_cut() {
            continue;
        }
        let min_x = seg.x0.min(seg.x1) - outer_r;
        let max_x = seg.x0.max(seg.x1) + outer_r;
        let min_y = seg.y0.min(seg.y1) - outer_r;
        let max_y = seg.y0.max(seg.y1) + outer_r;

        let ix0 = (((min_x - stock.min[0]) / dx).floor() as isize).clamp(0, (gw - 1) as isize) as usize;
        let ix1 = (((max_x - stock.min[0]) / dx).ceil() as isize).clamp(0, (gw - 1) as isize) as usize;
        let iy0 = (((min_y - stock.min[1]) / dy).floor() as isize).clamp(0, (gh - 1) as isize) as usize;
        let iy1 = (((max_y - stock.min[1]) / dy).ceil() as isize).clamp(0, (gh - 1) as isize) as usize;

        let sdx = seg.x1 - seg.x0;
        let sdy = seg.y1 - seg.y0;
        let sdz = seg.z1 - seg.z0;
        let len2 = sdx * sdx + sdy * sdy;

        for iy in iy0..=iy1 {
            let qy = stock.min[1] + (iy as f32) * dy;
            let row = iy * gw;
            for ix in ix0..=ix1 {
                let qx = stock.min[0] + (ix as f32) * dx;
                let t = if len2 > 1e-8 {
                    (((qx - seg.x0) * sdx + (qy - seg.y0) * sdy) / len2).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                let rx = qx - (seg.x0 + t * sdx);
                let ry = qy - (seg.y0 + t * sdy);
                let d2 = rx * rx + ry * ry;
                if d2 <= r2 {
                    if let Some(dz_env) = tool.envelope_dz(d2.sqrt()) {
                        let z_cut = (seg.z0 + t * sdz + dz_env).max(stock.min[2] - 0.2);
                        if z_cut < grid[row + ix] {
                            grid[row + ix] = z_cut;
                        }
                    }
                }
            }
        }
    }

    // Simple software z-buffer rasterizer of heightfield quads
    let mat = opts
        .material
        .unwrap_or_else(|| MaterialPreset::auto_for_tool(tool.kind, file_ext));
    let base_col = match mat {
        MaterialPreset::Aluminum6061 => Vec3::new(0.78, 0.82, 0.88),
        MaterialPreset::Rosewood => Vec3::new(0.58, 0.34, 0.19),
        MaterialPreset::Brass => Vec3::new(0.90, 0.73, 0.35),
        MaterialPreset::Jade => Vec3::new(0.48, 0.76, 0.66),
        MaterialPreset::PineWood => Vec3::new(0.88, 0.76, 0.56),
        MaterialPreset::DepthHeatmap => Vec3::new(0.24, 0.74, 0.68),
    };

    let center = Vec3::from_array(stock.center());
    let radius = (size[0].hypot(size[1]).hypot(size[2])) * 0.5;
    let yaw = opts.yaw_deg.to_radians();
    let pitch = opts.pitch_deg.to_radians();
    let dist = (radius * 2.35) / opts.zoom.max(0.2);
    let eye = center
        + Vec3::new(
            dist * pitch.cos() * yaw.sin(),
            -dist * pitch.cos() * yaw.cos(),
            dist * pitch.sin(),
        );
    let proj = Mat4::perspective_rh(34.0f32.to_radians(), (w as f32) / (h as f32), radius * 0.1, dist * 4.0);
    let view = Mat4::look_at_rh(eye, center, Vec3::Z);
    let vp = proj * view;

    let mut rgba = vec![0u8; w * h * 4];
    // Dark studio gradient background
    rgba.par_chunks_exact_mut(w * 4)
        .enumerate()
        .for_each(|(py, row)| {
            let v = (py as f32) / (h as f32);
            let r = (18.0 + (1.0 - v) * 10.0) as u8;
            let g = (22.0 + (1.0 - v) * 12.0) as u8;
            let b = (30.0 + (1.0 - v) * 16.0) as u8;
            for px in 0..w {
                row[px * 4] = r;
                row[px * 4 + 1] = g;
                row[px * 4 + 2] = b;
                row[px * 4 + 3] = 255;
            }
        });

    let mut zbuf = vec![f32::INFINITY; w * h];
    let light = Vec3::new(-0.48, -0.58, 0.66).normalize();

    let to_screen = |p: Vec3| -> Option<(f32, f32, f32)> {
        let clip: Vec4 = vp * p.extend(1.0);
        if clip.w <= 1e-4 {
            return None;
        }
        let ndc = clip. truncate() / clip.w;
        let sx = (ndc.x * 0.5 + 0.5) * (w as f32);
        let sy = (0.5 - ndc.y * 0.5) * (h as f32);
        Some((sx, sy, ndc.z))
    };

    for iy in 0..(gh - 1) {
        for ix in 0..(gw - 1) {
            let z00 = grid[iy * gw + ix];
            if z00 < stock.min[2] - 0.03 {
                continue;
            }
            let p00 = Vec3::new(stock.min[0] + ix as f32 * dx, stock.min[1] + iy as f32 * dy, z00.max(stock.min[2]));
            let p10 = Vec3::new(p00.x + dx, p00.y, grid[iy * gw + ix + 1].max(stock.min[2]));
            let p01 = Vec3::new(p00.x, p00.y + dy, grid[(iy + 1) * gw + ix].max(stock.min[2]));
            let p11 = Vec3::new(p00.x + dx, p00.y + dy, grid[(iy + 1) * gw + ix + 1].max(stock.min[2]));

            for (a, b, c) in [(p00, p10, p11), (p00, p11, p01)] {
                let n = (b - a).cross(c - a).normalize_or_zero();
                let diff = n.dot(light).max(0.0);
                let shade = (0.28 + 0.78 * diff).clamp(0.15, 1.15);
                let col = (base_col * shade).clamp(Vec3::ZERO, Vec3::ONE);
                let cr = (col.x * 255.0) as u8;
                let cg = (col.y * 255.0) as u8;
                let cb = (col.z * 255.0) as u8;

                if let (Some(s0), Some(s1), Some(s2)) = (to_screen(a), to_screen(b), to_screen(c)) {
                    let min_px = (s0.0.min(s1.0).min(s2.0).floor() as isize).max(0) as usize;
                    let max_px = (s0.0.max(s1.0).max(s2.0).ceil() as isize).min((w - 1) as isize) as usize;
                    let min_py = (s0.1.min(s1.1).min(s2.1).floor() as isize).max(0) as usize;
                    let max_py = (s0.1.max(s1.1).max(s2.1).ceil() as isize).min((h - 1) as isize) as usize;
                    let area = (s1.0 - s0.0) * (s2.1 - s0.1) - (s1.1 - s0.1) * (s2.0 - s0.0);
                    if area.abs() < 1e-4 {
                        continue;
                    }
                    let inv_area = 1.0 / area;
                    for py in min_py..=max_py {
                        let fy = py as f32 + 0.5;
                        for px in min_px..=max_px {
                            let fx = px as f32 + 0.5;
                            let w0 = ((s1.0 - fx) * (s2.1 - fy) - (s1.1 - fy) * (s2.0 - fx)) * inv_area;
                            let w1 = ((s2.0 - fx) * (s0.1 - fy) - (s2.1 - fy) * (s0.0 - fx)) * inv_area;
                            let w2 = 1.0 - w0 - w1;
                            if w0 >= 0.0 && w1 >= 0.0 && w2 >= 0.0 {
                                let z = w0 * s0.2 + w1 * s1.2 + w2 * s2.2;
                                let idx = py * w + px;
                                if z < zbuf[idx] {
                                    zbuf[idx] = z;
                                    rgba[idx * 4] = cr;
                                    rgba[idx * 4 + 1] = cg;
                                    rgba[idx * 4 + 2] = cb;
                                    rgba[idx * 4 + 3] = 255;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    rgba
}
