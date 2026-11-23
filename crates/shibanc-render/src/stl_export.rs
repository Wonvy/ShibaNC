//! Watertight Binary `.STL` 3D mesh exporter reconstructed from simulated 3-axis G-code heightfields.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use glam::Vec3;
use shibanc_gcode::ParsedProgram;

/// Carve the 3-axis heightfield at `grid_max_dim` resolution and write a watertight Binary `.STL` file.
/// Returns the total number of exported triangles.
pub fn export_program_binary_stl(
    program: &ParsedProgram,
    grid_max_dim: u32,
    active_segments: Option<usize>,
    output_path: &Path,
) -> Result<u32, String> {
    let stock = &program.stock;
    let tool = &program.tool;
    let sx = (stock.max[0] - stock.min[0]).max(0.5);
    let sy = (stock.max[1] - stock.min[1]).max(0.5);

    let max_dim = grid_max_dim.clamp(128, 1536) as f32;
    let scale = max_dim / sx.max(sy);
    let gw = ((sx * scale).round() as usize).clamp(64, 1536);
    let gh = ((sy * scale).round() as usize).clamp(64, 1536);
    let dx = sx / ((gw - 1) as f32);
    let dy = sy / ((gh - 1) as f32);

    let mut raw_grid = vec![stock.max[2]; gw * gh];
    let outer_r = (tool.diameter * 0.5).max(0.05);
    let r2 = outer_r * outer_r;
    let limit = active_segments
        .unwrap_or(program.segments.len())
        .min(program.segments.len());

    for seg in &program.segments[..limit] {
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
                        if z_cut < raw_grid[row + ix] {
                            raw_grid[row + ix] = z_cut;
                        }
                    }
                }
            }
        }
    }

    write_heightfield_binary_stl(
        &raw_grid,
        gw,
        gh,
        stock.min,
        stock.max,
        dx,
        dy,
        output_path,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn write_heightfield_binary_stl(
    raw_grid: &[f32],
    gw: usize,
    gh: usize,
    stock_min: [f32; 3],
    stock_max: [f32; 3],
    dx: f32,
    dy: f32,
    output_path: &Path,
) -> Result<u32, String> {
    let cells_x = gw - 1;
    let cells_y = gh - 1;
    let pierce_z = stock_min[2] - 0.03;

    // Classify solid vs pierced through-hole cells
    let mut solid = vec![false; cells_x * cells_y];
    for qy in 0..cells_y {
        for qx in 0..cells_x {
            let r00 = raw_grid[qy * gw + qx];
            let r10 = raw_grid[qy * gw + qx + 1];
            let r01 = raw_grid[(qy + 1) * gw + qx];
            let r11 = raw_grid[(qy + 1) * gw + qx + 1];
            // Pierced if all 4 corners (or >2 corners) pierced below stock bottom
            let pierced = r00 < pierce_z && r10 < pierce_z && r01 < pierce_z && r11 < pierce_z;
            solid[qy * cells_x + qx] = !pierced;
        }
    }

    let is_solid = |qx: isize, qy: isize| -> bool {
        if qx < 0 || qy < 0 || qx >= cells_x as isize || qy >= cells_y as isize {
            return false;
        }
        solid[(qy as usize) * cells_x + (qx as usize)]
    };

    // Count exact number of triangles for the Binary STL header
    let mut tri_count: u32 = 0;
    for qy in 0..cells_y {
        for qx in 0..cells_x {
            if !solid[qy * cells_x + qx] {
                continue;
            }
            // Top (2) + Bottom (2)
            tri_count += 4;
            if !is_solid(qx as isize, qy as isize - 1) {
                tri_count += 2;
            }
            if !is_solid(qx as isize, qy as isize + 1) {
                tri_count += 2;
            }
            if !is_solid(qx as isize - 1, qy as isize) {
                tri_count += 2;
            }
            if !is_solid(qx as isize + 1, qy as isize) {
                tri_count += 2;
            }
        }
    }

    if let Some(parent) = output_path.parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }

    let file = File::create(output_path).map_err(|e| format!("创建 STL 文件失败: {}", e))?;
    let mut writer = BufWriter::with_capacity(256 * 1024, file);

    // 80-byte Binary STL header
    let mut header = [0u8; 80];
    let title = b"ShibaNC Watertight 3-Axis Machined Mesh (Units: mm)";
    header[..title.len()].copy_from_slice(title);
    writer
        .write_all(&header)
        .map_err(|e| format!("写入 STL 头部失败: {}", e))?;
    writer
        .write_all(&tri_count.to_le_bytes())
        .map_err(|e| format!("写入三角形计数失败: {}", e))?;

    let top_pos = |ix: usize, iy: usize| -> Vec3 {
        let z = raw_grid[iy * gw + ix].clamp(stock_min[2], stock_max[2]);
        Vec3::new(
            stock_min[0] + (ix as f32) * dx,
            stock_min[1] + (iy as f32) * dy,
            z,
        )
    };

    let mut emit_tri = |a: Vec3, b: Vec3, c: Vec3| -> Result<(), String> {
        let n = (b - a).cross(c - a).normalize_or_zero();
        let mut rec = [0u8; 50];
        rec[0..4].copy_from_slice(&n.x.to_le_bytes());
        rec[4..8].copy_from_slice(&n.y.to_le_bytes());
        rec[8..12].copy_from_slice(&n.z.to_le_bytes());

        rec[12..16].copy_from_slice(&a.x.to_le_bytes());
        rec[16..20].copy_from_slice(&a.y.to_le_bytes());
        rec[20..24].copy_from_slice(&a.z.to_le_bytes());

        rec[24..28].copy_from_slice(&b.x.to_le_bytes());
        rec[28..32].copy_from_slice(&b.y.to_le_bytes());
        rec[32..36].copy_from_slice(&b.z.to_le_bytes());

        rec[36..40].copy_from_slice(&c.x.to_le_bytes());
        rec[40..44].copy_from_slice(&c.y.to_le_bytes());
        rec[44..48].copy_from_slice(&c.z.to_le_bytes());
        // rec[48..50] = 0u16 attribute byte count
        writer
            .write_all(&rec)
            .map_err(|e| format!("写入 STL 面片失败: {}", e))
    };

    let z_bot = stock_min[2];
    for qy in 0..cells_y {
        for qx in 0..cells_x {
            if !solid[qy * cells_x + qx] {
                continue;
            }
            let p00 = top_pos(qx, qy);
            let p10 = top_pos(qx + 1, qy);
            let p01 = top_pos(qx, qy + 1);
            let p11 = top_pos(qx + 1, qy + 1);

            // 1. Top machined quad (split along shorter Z diagonal)
            if (p11.z - p00.z).abs() <= (p10.z - p01.z).abs() {
                emit_tri(p00, p10, p11)?;
                emit_tri(p00, p11, p01)?;
            } else {
                emit_tri(p00, p10, p01)?;
                emit_tri(p10, p11, p01)?;
            }

            // 2. Bottom cap quad (normal -Z)
            let b00 = Vec3::new(p00.x, p00.y, z_bot);
            let b10 = Vec3::new(p10.x, p10.y, z_bot);
            let b01 = Vec3::new(p01.x, p01.y, z_bot);
            let b11 = Vec3::new(p11.x, p11.y, z_bot);
            emit_tri(b00, b11, b10)?;
            emit_tri(b00, b01, b11)?;

            // 3. Outer stock walls & internal through-hole walls
            if !is_solid(qx as isize, qy as isize - 1) {
                // South wall (-Y)
                emit_tri(b00, b10, p10)?;
                emit_tri(b00, p10, p00)?;
            }
            if !is_solid(qx as isize, qy as isize + 1) {
                // North wall (+Y)
                emit_tri(b11, b01, p01)?;
                emit_tri(b11, p01, p11)?;
            }
            if !is_solid(qx as isize - 1, qy as isize) {
                // West wall (-X)
                emit_tri(b01, b00, p00)?;
                emit_tri(b01, p00, p01)?;
            }
            if !is_solid(qx as isize + 1, qy as isize) {
                // East wall (+X)
                emit_tri(b10, b11, p11)?;
                emit_tri(b10, p11, p10)?;
            }
        }
    }

    writer
        .flush()
        .map_err(|e| format!("刷新 STL 输出失败: {}", e))?;
    Ok(tri_count)
}
