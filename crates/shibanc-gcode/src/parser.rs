use std::fs::File;
use std::path::Path;
use std::time::Instant;

use memmap2::Mmap;
use thiserror::Error;

use crate::infer::{infer_stock_and_tool, HeaderHints};
use crate::types::{GpuSegment, ParsedProgram, ToolpathStats};

#[derive(Debug, Error)]
pub enum GcodeError {
    #[error("无法打开文件: {0}")]
    Io(#[from] std::io::Error),
    #[error("G 代码文件内容为空")]
    EmptyFile,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MotionMode {
    Rapid,   // G0
    Linear,  // G1
    ArcCw,   // G2
    ArcCcw,  // G3
    Drill,   // G81/G82/G83
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Plane {
    XY, // G17
    ZX, // G18
    YZ, // G19
}

/// Parse a `.tap` / `.nc` / `.gcode` file from disk using zero-copy OS memory mapping.
pub fn parse_file(path: &Path) -> Result<ParsedProgram, GcodeError> {
    let file = File::open(path)?;
    let meta = file.metadata()?;
    if meta.len() == 0 {
        return Err(GcodeError::EmptyFile);
    }
    let mmap = unsafe { Mmap::map(&file)? };
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "unknown.nc".to_string());
    let ext = path
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    parse_bytes(&mmap, &file_name, &ext)
}

/// High-speed byte-stream RS-274 / Fanuc / Mach3 / SurfMill G-code parser.
pub fn parse_bytes(bytes: &[u8], file_name: &str, file_ext: &str) -> Result<ParsedProgram, GcodeError> {
    if bytes.is_empty() {
        return Err(GcodeError::EmptyFile);
    }
    let t0 = Instant::now();

    // Estimate capacity (~1.1 segments per 26 bytes of G-code)
    let est_segs = (bytes.len() / 24).clamp(256, 4_000_000);
    let mut segments: Vec<GpuSegment> = Vec::with_capacity(est_segs);
    let mut preview_lines: Vec<String> = Vec::with_capacity(2000);
    let mut hints = HeaderHints::default();

    // Modal state
    let mut motion = MotionMode::Rapid;
    let mut plane = Plane::XY;
    let mut absolute_xyz = true;
    let mut absolute_ijk = false;
    let mut unit_scale = 1.0f32; // 1.0 = mm (G21), 25.4 = inch (G20)

    let mut pos = [0.0f32, 0.0f32, 20.0f32];
    let mut pos_initialized = [false, false, false];
    let mut feedrate = 1200.0f32; // mm/min
    let mut tool_slot: u8 = 0;
    let mut canned_r_z: f32 = 2.0;
    let mut canned_z: f32 = -5.0;

    // Stats accumulators
    let mut rapid_count = 0usize;
    let mut cut_count = 0usize;
    let mut rapid_len = 0.0f64;
    let mut cut_len = 0.0f64;
    let mut cut_time_sec = 0.0f64;
    let mut cut_min = [f32::INFINITY; 3];
    let mut cut_max = [f32::NEG_INFINITY; 3];

    let mut line_no: u32 = 0;
    let mut i = 0usize;
    let len = bytes.len();

    while i < len {
        // Find end of current line
        let line_start = i;
        while i < len && bytes[i] != b'\n' && bytes[i] != b'\r' {
            i += 1;
        }
        let line_end = i;
        // Consume CRLF / LF
        if i < len && bytes[i] == b'\r' {
            i += 1;
        }
        if i < len && bytes[i] == b'\n' {
            i += 1;
        }
        line_no = line_no.saturating_add(1);

        let line = &bytes[line_start..line_end];
        if preview_lines.len() < 300_000 {
            preview_lines.push(String::from_utf8_lossy(line).into_owned());
        }
        if line.is_empty() {
            continue;
        }

        // Per-block words
        let mut target_x: Option<f32> = None;
        let mut target_y: Option<f32> = None;
        let mut target_z: Option<f32> = None;
        let mut arc_i: Option<f32> = None;
        let mut arc_j: Option<f32> = None;
        let mut arc_k: Option<f32> = None;
        let mut arc_r: Option<f32> = None;
        let mut has_xyz = false;
        let mut is_machine_home_g28_g53 = false;

        let mut p = 0usize;
        let llen = line.len();
        while p < llen {
            let b = line[p];
            // Whitespace or '%' tape marker
            if b <= b' ' || b == b'%' {
                p += 1;
                continue;
            }
            // Semicolon comment to end of line
            if b == b';' {
                if line_no <= 200 {
                    hints.inspect_comment(&line[p + 1..]);
                }
                break;
            }
            // Parenthetical comment (...)
            if b == b'(' {
                let c_start = p + 1;
                p += 1;
                while p < llen && line[p] != b')' {
                    p += 1;
                }
                if line_no <= 200 {
                    hints.inspect_comment(&line[c_start..p]);
                }
                if p < llen {
                    p += 1;
                }
                continue;
            }

            let letter = b.to_ascii_uppercase();
            if !letter.is_ascii_alphabetic() {
                p += 1;
                continue;
            }
            p += 1;

            // Skip spaces between letter and number (e.g. "X 12.34" in some Mach3/Heidenhain posts)
            while p < llen && (line[p] == b' ' || line[p] == b'\t') {
                p += 1;
            }

            let (val, next_p) = match parse_f32_fast(line, p) {
                Some(res) => res,
                None => continue,
            };
            p = next_p;

            match letter {
                b'G' => {
                    let g_int = (val * 10.0).round() as i32;
                    match g_int {
                        0 => motion = MotionMode::Rapid,
                        10 => motion = MotionMode::Linear,
                        20 => motion = MotionMode::ArcCw,
                        30 => motion = MotionMode::ArcCcw,
                        170 => plane = Plane::XY,
                        180 => plane = Plane::ZX,
                        190 => plane = Plane::YZ,
                        200 => unit_scale = 25.4,
                        210 => unit_scale = 1.0,
                        280 | 300 | 530 => is_machine_home_g28_g53 = true,
                        800 => motion = MotionMode::Rapid,
                        810 | 820 | 830 => motion = MotionMode::Drill,
                        900 => absolute_xyz = true,
                        901 => absolute_ijk = true,
                        910 => absolute_xyz = false,
                        911 => absolute_ijk = false,
                        _ => {}
                    }
                }
                b'X' => {
                    target_x = Some(val * unit_scale);
                    has_xyz = true;
                }
                b'Y' => {
                    target_y = Some(val * unit_scale);
                    has_xyz = true;
                }
                b'Z' => {
                    target_z = Some(val * unit_scale);
                    has_xyz = true;
                }
                b'I' => arc_i = Some(val * unit_scale),
                b'J' => arc_j = Some(val * unit_scale),
                b'K' => arc_k = Some(val * unit_scale),
                b'R' => arc_r = Some(val * unit_scale),
                b'F' => {
                    if val > 0.0 {
                        feedrate = val * unit_scale;
                    }
                }
                b'T' => {
                    let tid = (val.round() as i32).clamp(0, 255) as u8;
                    tool_slot = tid;
                    if hints.tool_id.is_none() && tid > 0 {
                        hints.tool_id = Some(tid as u32);
                    }
                }
                _ => {}
            }
        }

        if is_machine_home_g28_g53 || !has_xyz {
            continue;
        }

        if motion == MotionMode::Drill {
            if let Some(r_plane) = arc_r {
                canned_r_z = if absolute_xyz { r_plane } else { pos[2] + r_plane };
            }
            if let Some(z_val) = target_z {
                canned_z = if absolute_xyz { z_val } else { pos[2] + z_val };
            }
        }

        let next_x = match target_x {
            Some(v) => if absolute_xyz { v } else { pos[0] + v },
            None => pos[0],
        };
        let next_y = match target_y {
            Some(v) => if absolute_xyz { v } else { pos[1] + v },
            None => pos[1],
        };
        let next_z = if motion == MotionMode::Drill {
            canned_z
        } else {
            match target_z {
                Some(v) => if absolute_xyz { v } else { pos[2] + v },
                None => pos[2],
            }
        };

        // On very first move, initialize starting coordinate cleanly without drawing an artificial diagonal from (0,0,20)
        if !pos_initialized[0] && !pos_initialized[1] && motion == MotionMode::Rapid {
            if target_x.is_some() {
                pos[0] = next_x;
                pos_initialized[0] = true;
            }
            if target_y.is_some() {
                pos[1] = next_y;
                pos_initialized[1] = true;
            }
            if target_z.is_some() {
                pos[2] = next_z;
                pos_initialized[2] = true;
            }
            continue;
        }
        pos_initialized = [true, true, true];

        let next_pos = [next_x, next_y, next_z];

        match motion {
            MotionMode::Rapid => {
                push_segment(
                    &mut segments,
                    pos,
                    next_pos,
                    false,
                    tool_slot,
                    feedrate,
                    line_no,
                    &mut rapid_count,
                    &mut cut_count,
                    &mut rapid_len,
                    &mut cut_len,
                    &mut cut_time_sec,
                    &mut cut_min,
                    &mut cut_max,
                );
                pos = next_pos;
            }
            MotionMode::Linear => {
                push_segment(
                    &mut segments,
                    pos,
                    next_pos,
                    true,
                    tool_slot,
                    feedrate,
                    line_no,
                    &mut rapid_count,
                    &mut cut_count,
                    &mut rapid_len,
                    &mut cut_len,
                    &mut cut_time_sec,
                    &mut cut_min,
                    &mut cut_max,
                );
                pos = next_pos;
            }
            MotionMode::Drill => {
                // Canned cycle: Rapid XY -> Rapid Z to R-plane -> Feed Z to bottom -> Rapid Z retract
                let xy_above = [next_x, next_y, pos[2].max(canned_r_z)];
                push_segment(
                    &mut segments, pos, xy_above, false, tool_slot, feedrate, line_no,
                    &mut rapid_count, &mut cut_count, &mut rapid_len, &mut cut_len, &mut cut_time_sec, &mut cut_min, &mut cut_max,
                );
                let at_r = [next_x, next_y, canned_r_z];
                push_segment(
                    &mut segments, xy_above, at_r, false, tool_slot, feedrate, line_no,
                    &mut rapid_count, &mut cut_count, &mut rapid_len, &mut cut_len, &mut cut_time_sec, &mut cut_min, &mut cut_max,
                );
                let bottom = [next_x, next_y, next_z];
                push_segment(
                    &mut segments, at_r, bottom, true, tool_slot, feedrate, line_no,
                    &mut rapid_count, &mut cut_count, &mut rapid_len, &mut cut_len, &mut cut_time_sec, &mut cut_min, &mut cut_max,
                );
                push_segment(
                    &mut segments, bottom, at_r, false, tool_slot, feedrate, line_no,
                    &mut rapid_count, &mut cut_count, &mut rapid_len, &mut cut_len, &mut cut_time_sec, &mut cut_min, &mut cut_max,
                );
                pos = at_r;
            }
            MotionMode::ArcCw | MotionMode::ArcCcw => {
                let cw = motion == MotionMode::ArcCw;
                tessellate_arc(
                    pos,
                    next_pos,
                    plane,
                    cw,
                    absolute_ijk,
                    arc_i,
                    arc_j,
                    arc_k,
                    arc_r,
                    tool_slot,
                    feedrate,
                    line_no,
                    &mut segments,
                    &mut rapid_count,
                    &mut cut_count,
                    &mut rapid_len,
                    &mut cut_len,
                    &mut cut_time_sec,
                    &mut cut_min,
                    &mut cut_max,
                );
                pos = next_pos;
            }
        }
    }

    let parse_time_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let (stock, tool) = infer_stock_and_tool(&segments, &hints, file_ext);

    if !cut_min[0].is_finite() {
        cut_min = stock.min;
        cut_max = stock.max;
    }

    // Add rapid time assuming 4000 mm/min rapid traverse
    let rapid_time_sec = (rapid_len / 4000.0) * 60.0;

    let stats = ToolpathStats {
        file_name: file_name.to_string(),
        file_size_bytes: bytes.len() as u64,
        total_lines: line_no,
        segment_count: segments.len(),
        rapid_segment_count: rapid_count,
        cut_segment_count: cut_count,
        rapid_length_mm: rapid_len,
        cut_length_mm: cut_len,
        estimated_time_sec: cut_time_sec + rapid_time_sec,
        parse_time_ms,
        cut_bounds_min: cut_min,
        cut_bounds_max: cut_max,
    };

    Ok(ParsedProgram {
        segments,
        tool,
        stock,
        stats,
        preview_lines,
    })
}

#[inline]
#[allow(clippy::too_many_arguments)]
fn push_segment(
    segments: &mut Vec<GpuSegment>,
    p0: [f32; 3],
    p1: [f32; 3],
    is_cut: bool,
    tool_slot: u8,
    feedrate: f32,
    line_no: u32,
    rapid_count: &mut usize,
    cut_count: &mut usize,
    rapid_len: &mut f64,
    cut_len: &mut f64,
    cut_time_sec: &mut f64,
    cut_min: &mut [f32; 3],
    cut_max: &mut [f32; 3],
) {
    let dx = p1[0] - p0[0];
    let dy = p1[1] - p0[1];
    let dz = p1[2] - p0[2];
    let dist_sq = dx * dx + dy * dy + dz * dz;
    if dist_sq < 1e-10 {
        return;
    }
    let dist = (dist_sq as f64).sqrt();
    if is_cut {
        *cut_count += 1;
        *cut_len += dist;
        *cut_time_sec += (dist / (feedrate.max(10.0) as f64)) * 60.0;
        for a in 0..3 {
            cut_min[a] = cut_min[a].min(p0[a]).min(p1[a]);
            cut_max[a] = cut_max[a].max(p0[a]).max(p1[a]);
        }
        // Subdivide long linear cuts (> 2.5mm) so GPU compute threads have small bounded
        // 2D footprints and timeline scrubbing animates smoothly along straight walls.
        const MAX_CUT_STEP: f64 = 2.5;
        if dist > MAX_CUT_STEP {
            let steps = ((dist / MAX_CUT_STEP).ceil() as usize).min(256);
            let mut prev = p0;
            for s in 1..=steps {
                let pt = if s == steps {
                    p1
                } else {
                    let t = (s as f32) / (steps as f32);
                    [p0[0] + dx * t, p0[1] + dy * t, p0[2] + dz * t]
                };
                segments.push(GpuSegment::new(prev, pt, true, tool_slot, feedrate, line_no));
                prev = pt;
            }
            return;
        }
    } else {
        *rapid_count += 1;
        *rapid_len += dist;
    }
    segments.push(GpuSegment::new(p0, p1, is_cut, tool_slot, feedrate, line_no));
}

#[allow(clippy::too_many_arguments)]
fn tessellate_arc(
    p0: [f32; 3],
    p1: [f32; 3],
    plane: Plane,
    cw: bool,
    absolute_ijk: bool,
    arc_i: Option<f32>,
    arc_j: Option<f32>,
    arc_k: Option<f32>,
    arc_r: Option<f32>,
    tool_slot: u8,
    feedrate: f32,
    line_no: u32,
    segments: &mut Vec<GpuSegment>,
    rapid_count: &mut usize,
    cut_count: &mut usize,
    rapid_len: &mut f64,
    cut_len: &mut f64,
    cut_time_sec: &mut f64,
    cut_min: &mut [f32; 3],
    cut_max: &mut [f32; 3],
) {
    // Map plane axes (u, v, w_helical)
    let (ax_u, ax_v, ax_w, off_u, off_v) = match plane {
        Plane::XY => (0, 1, 2, arc_i, arc_j),
        Plane::ZX => (2, 0, 1, arc_k, arc_i),
        Plane::YZ => (1, 2, 0, arc_j, arc_k),
    };

    let u0 = p0[ax_u] as f64;
    let v0 = p0[ax_v] as f64;
    let u1 = p1[ax_u] as f64;
    let v1 = p1[ax_v] as f64;

    let (cu, cv) = if let Some(r_val) = arc_r {
        let r = (r_val as f64).abs();
        let du = u1 - u0;
        let dv = v1 - v0;
        let d2 = du * du + dv * dv;
        let d = d2.sqrt();
        if d < 1e-9 || r < 1e-6 {
            push_segment(
                segments, p0, p1, true, tool_slot, feedrate, line_no,
                rapid_count, cut_count, rapid_len, cut_len, cut_time_sec, cut_min, cut_max,
            );
            return;
        }
        let h_sq = (r * r - 0.25 * d2).max(0.0);
        let mut h = h_sq.sqrt();
        // Standard RS-274 R sign convention: R < 0 selects > 180 deg arc
        let sign = if (cw && r_val > 0.0) || (!cw && r_val < 0.0) { -1.0 } else { 1.0 };
        h *= sign;
        let mu = 0.5 * (u0 + u1);
        let mv = 0.5 * (v0 + v1);
        (mu - h * (dv / d), mv + h * (du / d))
    } else {
        let iu = off_u.unwrap_or(0.0) as f64;
        let iv = off_v.unwrap_or(0.0) as f64;
        if absolute_ijk {
            (iu, iv)
        } else {
            (u0 + iu, v0 + iv)
        }
    };

    let r0 = ((u0 - cu).powi(2) + (v0 - cv).powi(2)).sqrt();
    let r1 = ((u1 - cu).powi(2) + (v1 - cv).powi(2)).sqrt();
    if r0 < 1e-5 {
        push_segment(
            segments, p0, p1, true, tool_slot, feedrate, line_no,
            rapid_count, cut_count, rapid_len, cut_len, cut_time_sec, cut_min, cut_max,
        );
        return;
    }

    let ang0 = (v0 - cv).atan2(u0 - cu);
    let ang1 = (v1 - cv).atan2(u1 - cu);
    let mut sweep = ang1 - ang0;

    if cw {
        if sweep >= -1e-7 {
            sweep -= std::f64::consts::TAU;
        }
    } else if sweep <= 1e-7 {
        sweep += std::f64::consts::TAU;
    }

    // Chord tolerance <= 0.012mm for razor-sharp circular walls!
    let chord_tol = 0.012f64;
    let max_step_ang = if r0 > chord_tol {
        (2.0 * (1.0 - chord_tol / r0).clamp(-1.0, 1.0).acos()).clamp(0.02, 0.25)
    } else {
        0.25
    };
    let steps = ((sweep.abs() / max_step_ang).ceil() as usize).clamp(4, 360);

    let mut prev = p0;
    for s in 1..=steps {
        if s == steps {
            push_segment(
                segments, prev, p1, true, tool_slot, feedrate, line_no,
                rapid_count, cut_count, rapid_len, cut_len, cut_time_sec, cut_min, cut_max,
            );
        } else {
            let t = (s as f64) / (steps as f64);
            let ang = ang0 + sweep * t;
            let r = r0 + (r1 - r0) * t;
            let mut pt = [0.0f32; 3];
            pt[ax_u] = (cu + r * ang.cos()) as f32;
            pt[ax_v] = (cv + r * ang.sin()) as f32;
            pt[ax_w] = p0[ax_w] + (p1[ax_w] - p0[ax_w]) * (t as f32);
            push_segment(
                segments, prev, pt, true, tool_slot, feedrate, line_no,
                rapid_count, cut_count, rapid_len, cut_len, cut_time_sec, cut_min, cut_max,
            );
            prev = pt;
        }
    }
}

/// Ultra-fast zero-allocation ASCII float parser (`-123.456`).
#[inline]
fn parse_f32_fast(buf: &[u8], mut idx: usize) -> Option<(f32, usize)> {
    let len = buf.len();
    if idx >= len {
        return None;
    }
    let mut neg = false;
    if buf[idx] == b'-' {
        neg = true;
        idx += 1;
    } else if buf[idx] == b'+' {
        idx += 1;
    }

    let start_digits = idx;
    let mut int_part: i64 = 0;
    while idx < len && buf[idx].is_ascii_digit() {
        int_part = int_part.wrapping_mul(10).wrapping_add((buf[idx] - b'0') as i64);
        idx += 1;
    }

    let mut frac_part: i64 = 0;
    let mut frac_div: f64 = 1.0;
    if idx < len && buf[idx] == b'.' {
        idx += 1;
        while idx < len && buf[idx].is_ascii_digit() {
            if frac_div < 1e12 {
                frac_part = frac_part * 10 + (buf[idx] - b'0') as i64;
                frac_div *= 10.0;
            }
            idx += 1;
        }
    }

    if idx == start_digits || (idx == start_digits + 1 && buf[start_digits] == b'.') {
        return None;
    }

    let mut val = (int_part as f64) + (frac_part as f64) / frac_div;
    if neg {
        val = -val;
    }
    Some((val as f32, idx))
}
