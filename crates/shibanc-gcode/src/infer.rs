use crate::types::{GpuSegment, StockSpec, ToolKind, ToolSpec};

/// Comments metadata extracted from CAM headers (Fusion 360, Mastercam, PowerMill, SurfMill, ArtCAM, Aspire).
#[derive(Default, Debug, Clone)]
pub struct HeaderHints {
    pub stock_min: Option<[f32; 3]>,
    pub stock_max: Option<[f32; 3]>,
    pub stock_dims: Option<[f32; 3]>,
    pub tool_diameter: Option<f32>,
    pub tool_tip_radius: Option<f32>,
    pub tool_half_angle: Option<f32>,
    pub tool_kind: Option<ToolKind>,
    pub tool_id: Option<u32>,
}

impl HeaderHints {
    pub fn inspect_comment(&mut self, raw: &[u8]) {
        // ASCII case-insensitive scan so GBK bytes in Chinese comments never fail UTF-8 decoding.
        let s = String::from_utf8_lossy(raw);
        let up = s.to_ascii_uppercase();

        // 1. Fusion 360 / Mastercam / CAMotics stock block:
        // e.g. (STOCK/BLOCK, 100, 80, 20, 50, 40, 20) -> dx, dy, dz, ox, oy, oz
        if up.contains("STOCK/BLOCK") {
            let nums = extract_floats(&up);
            if nums.len() >= 6 {
                let (dx, dy, dz) = (nums[0].abs(), nums[1].abs(), nums[2].abs());
                let (ox, oy, oz) = (nums[3], nums[4], nums[5]);
                if dx > 0.1 && dy > 0.1 && dz > 0.1 {
                    self.stock_min = Some([-ox, -oy, -oz]);
                    self.stock_max = Some([dx - ox, dy - oy, dz - oz]);
                }
            } else if nums.len() >= 3 {
                let (dx, dy, dz) = (nums[0].abs(), nums[1].abs(), nums[2].abs());
                if dx > 0.1 && dy > 0.1 && dz > 0.1 {
                    self.stock_dims = Some([dx, dy, dz]);
                }
            }
        }

        // 2. Fusion 360 / HSM tool comment:
        // e.g. (T1  D=6. CR=3. - ZMIN=-14.5 - ball end mill)
        // or   (T2 D=3.175 CR=0.25 TAPER=3.5deg - tapered mill)
        if (up.contains("D=") || up.contains("DIA") || up.contains("TOOL") || up.contains("MILL") || up.contains("ENDMILL") || up.contains("BALL") || up.contains("V-BIT") || up.contains("TAPER"))
            && self.tool_diameter.is_none()
        {
            if let Some(d) = find_tagged_number(&up, "D=")
                .or_else(|| find_tagged_number(&up, "DIA="))
                .or_else(|| find_tagged_number(&up, "DIAMETER="))
                .or_else(|| find_tagged_number(&up, "DIAMETER:"))
            {
                if d > 0.05 && d < 200.0 {
                    self.tool_diameter = Some(d);
                }
            }
            if let Some(cr) = find_tagged_number(&up, "CR=").or_else(|| find_tagged_number(&up, "R=")) {
                if cr >= 0.0 && cr < 100.0 {
                    self.tool_tip_radius = Some(cr);
                }
            }
            if let Some(ang) = find_tagged_number(&up, "TAPER=").or_else(|| find_tagged_number(&up, "ANGLE=")) {
                if ang > 0.1 && ang < 85.0 {
                    self.tool_half_angle = Some(ang);
                }
            }

            if up.contains("TAPER") && (up.contains("BALL") || self.tool_tip_radius.unwrap_or(0.0) > 0.05) {
                self.tool_kind = Some(ToolKind::TaperedBallNose);
            } else if up.contains("V-BIT") || up.contains("VBIT") || up.contains("CHAMFER") || up.contains("ENGRAV") {
                self.tool_kind = Some(ToolKind::VBit);
            } else if up.contains("BALL") || up.contains("SPHERE") {
                self.tool_kind = Some(ToolKind::BallNose);
            } else if up.contains("BULL") {
                self.tool_kind = Some(ToolKind::BullNose);
            } else if up.contains("FLAT") || up.contains("END MILL") || up.contains("ENDMILL") {
                if let (Some(d), Some(cr)) = (self.tool_diameter, self.tool_tip_radius) {
                    if (cr - d * 0.5).abs() < 0.02 {
                        self.tool_kind = Some(ToolKind::BallNose);
                    } else if cr > 0.05 {
                        self.tool_kind = Some(ToolKind::BullNose);
                    } else {
                        self.tool_kind = Some(ToolKind::FlatEndMill);
                    }
                } else {
                    self.tool_kind = Some(ToolKind::FlatEndMill);
                }
            }
        }
    }
}

fn find_tagged_number(s: &str, tag: &str) -> Option<f32> {
    let idx = s.find(tag)? + tag.len();
    let rest = s[idx..].trim_start();
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+'))
        .unwrap_or(rest.len());
    if end == 0 {
        return None;
    }
    rest[..end].parse::<f32>().ok()
}

fn extract_floats(s: &str) -> Vec<f32> {
    let mut res = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        if ch.is_ascii_digit() || ch == '.' || (ch == '-' && cur.is_empty()) {
            cur.push(ch);
        } else if !cur.is_empty() {
            if let Ok(v) = cur.parse::<f32>() {
                res.push(v);
            }
            cur.clear();
        }
    }
    if !cur.is_empty() {
        if let Ok(v) = cur.parse::<f32>() {
            res.push(v);
        }
    }
    res
}

/// Infer StockSpec and ToolSpec from cutting segments + optional CAM header hints.
pub fn infer_stock_and_tool(
    segments: &[GpuSegment],
    hints: &HeaderHints,
    file_ext: &str,
) -> (StockSpec, ToolSpec) {
    let mut min_c = [f32::INFINITY; 3];
    let mut max_c = [f32::NEG_INFINITY; 3];
    let mut has_cut = false;

    // Sample cutting segments for geometric heuristics (stepover & continuous 3D Z ratio)
    let mut z_sloped_moves = 0usize;
    let mut xy_cut_moves = 0usize;
    let mut stepover_samples: Vec<f32> = Vec::with_capacity(512);

    let mut prev_dir: Option<[f32; 2]> = None;
    let mut prev_seg_start: Option<[f32; 2]> = None;

    let stride = (segments.len() / 8000).max(1);
    for (idx, seg) in segments.iter().enumerate() {
        if !seg.is_cut() {
            continue;
        }
        has_cut = true;
        min_c[0] = min_c[0].min(seg.x0).min(seg.x1);
        min_c[1] = min_c[1].min(seg.y0).min(seg.y1);
        min_c[2] = min_c[2].min(seg.z0).min(seg.z1);
        max_c[0] = max_c[0].max(seg.x0).max(seg.x1);
        max_c[1] = max_c[1].max(seg.y0).max(seg.y1);
        max_c[2] = max_c[2].max(seg.z0).max(seg.z1);

        if idx % stride == 0 {
            let dx = seg.x1 - seg.x0;
            let dy = seg.y1 - seg.y0;
            let dz = (seg.z1 - seg.z0).abs();
            let len_xy = (dx * dx + dy * dy).sqrt();
            if len_xy > 0.05 {
                xy_cut_moves += 1;
                if dz > 0.005 && dz < len_xy * 4.0 {
                    z_sloped_moves += 1;
                }
                let dir = [dx / len_xy, dy / len_xy];
                if let (Some(pd), Some(ps)) = (prev_dir, prev_seg_start) {
                    // Parallel or anti-parallel raster scan pass detection
                    let dot = (dir[0] * pd[0] + dir[1] * pd[1]).abs();
                    if dot > 0.985 && stepover_samples.len() < 512 {
                        // Perpendicular distance between adjacent parallel passes
                        let vx = seg.x0 - ps[0];
                        let vy = seg.y0 - ps[1];
                        let perp = (vx * (-dir[1]) + vy * dir[0]).abs();
                        if perp > 0.02 && perp < 20.0 {
                            stepover_samples.push(perp);
                        }
                    }
                }
                prev_dir = Some(dir);
                prev_seg_start = Some([seg.x0, seg.y0]);
            }
        }
    }

    if !has_cut {
        // Fallback if file only contains rapids or is empty
        for seg in segments {
            min_c[0] = min_c[0].min(seg.x0).min(seg.x1);
            min_c[1] = min_c[1].min(seg.y0).min(seg.y1);
            min_c[2] = min_c[2].min(seg.z0).min(seg.z1);
            max_c[0] = max_c[0].max(seg.x0).max(seg.x1);
            max_c[1] = max_c[1].max(seg.y0).max(seg.y1);
            max_c[2] = max_c[2].max(seg.z0).max(seg.z1);
        }
        if !min_c[0].is_finite() {
            min_c = [-50.0, -50.0, -10.0];
            max_c = [50.0, 50.0, 0.0];
        }
    }

    let span_x = (max_c[0] - min_c[0]).max(1.0);
    let span_y = (max_c[1] - min_c[1]).max(1.0);
    let span_max = span_x.max(span_y);

    // --- 1. Tool Inference ---
    let mut median_stepover: Option<f32> = None;
    if stepover_samples.len() >= 6 {
        stepover_samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        // Use 25th percentile to reject occasional Rapid/reposition jumps between parallel islands
        median_stepover = Some(stepover_samples[stepover_samples.len() / 4]);
    }

    let ratio_3d = if xy_cut_moves > 0 {
        z_sloped_moves as f32 / xy_cut_moves as f32
    } else {
        0.0
    };

    let is_tap = file_ext.eq_ignore_ascii_case("tap");
    let tool = if let Some(d) = hints.tool_diameter {
        let kind = hints.tool_kind.unwrap_or(if ratio_3d > 0.35 {
            ToolKind::BallNose
        } else {
            ToolKind::FlatEndMill
        });
        let tip_r = hints.tool_tip_radius.unwrap_or(match kind {
            ToolKind::BallNose => d * 0.5,
            ToolKind::TaperedBallNose => (d * 0.12).clamp(0.25, 1.5),
            ToolKind::BullNose => (d * 0.15).clamp(0.2, 2.0),
            ToolKind::VBit => 0.05,
            ToolKind::FlatEndMill => 0.0,
        });
        let half_ang = hints.tool_half_angle.unwrap_or(match kind {
            ToolKind::TaperedBallNose => 3.5,
            ToolKind::VBit => 30.0,
            _ => 0.0,
        });
        ToolSpec {
            id: hints.tool_id.unwrap_or(1),
            kind,
            diameter: d,
            tip_radius: tip_r,
            half_angle_deg: half_ang,
            flute_length: (d * 4.0).max(20.0),
            inferred: false,
        }
    } else if ratio_3d > 0.28 || (is_tap && ratio_3d > 0.12) {
        // 3D relief / freeform surface finishing (.tap wood/jade carving or 3D mold finishing)
        let step = median_stepover.unwrap_or((span_max * 0.004).clamp(0.12, 0.8));
        if step <= 0.45 {
            // Fine tapered ballnose (standard relief carving cutter, e.g. R0.25~R0.75, 3.5° taper, D3.175/D4/D6)
            let tip_r = (step * 3.2).clamp(0.25, 1.0);
            let shank_d = if tip_r <= 0.55 { 3.175 } else { 6.0 };
            ToolSpec {
                id: hints.tool_id.unwrap_or(1),
                kind: ToolKind::TaperedBallNose,
                diameter: shank_d,
                tip_radius: (tip_r * 20.0).round() / 20.0,
                half_angle_deg: 3.5,
                flute_length: 25.0,
                inferred: true,
            }
        } else {
            // Standard 3D ballnose finishing/semi-finishing
            let d = (step * 5.0).clamp(2.0, 12.0).round();
            ToolSpec {
                id: hints.tool_id.unwrap_or(1),
                kind: ToolKind::BallNose,
                diameter: d,
                tip_radius: d * 0.5,
                half_angle_deg: 0.0,
                flute_length: (d * 4.0).max(20.0),
                inferred: true,
            }
        }
    } else {
        // 2.5D pocketing / profiling / mechanical milling (.nc)
        let raw_d = if let Some(step) = median_stepover {
            (step / 0.45).clamp(1.5, 16.0)
        } else {
            (span_max * 0.05).clamp(2.0, 10.0)
        };
        // Snap to standard metric cutter diameters
        let std_diameters = [1.0f32, 1.5, 2.0, 3.0, 3.175, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0, 16.0];
        let mut d = 6.0f32;
        let mut best_err = f32::INFINITY;
        for &cand in &std_diameters {
            let err = (cand - raw_d).abs();
            if err < best_err {
                best_err = err;
                d = cand;
            }
        }
        ToolSpec {
            id: hints.tool_id.unwrap_or(1),
            kind: ToolKind::FlatEndMill,
            diameter: d,
            tip_radius: 0.0,
            half_angle_deg: 0.0,
            flute_length: (d * 3.5).max(20.0),
            inferred: true,
        }
    };

    // --- 2. Stock Inference ---
    let stock = if let (Some(smin), Some(smax)) = (hints.stock_min, hints.stock_max) {
        StockSpec {
            min: smin,
            max: smax,
            inferred: false,
        }
    } else {
        let tool_r = tool.diameter * 0.5;
        let pad_xy = (tool_r + span_max * 0.035).clamp(1.5, 12.0);
        // Stock top Z: in 95% of 3-axis G-code, Z=0 is either workpiece top or spoilboard bottom.
        // If min_c[2] < 0 and max_c[2] <= 0.5, Z=0 is clearly Stock Top!
        // If min_c[2] >= 0 (spoilboard Z=0 convention), Stock Top is max_c[2] (highest cut surface).
        let z_top = if min_c[2] < -0.02 && max_c[2] <= 0.5 {
            0.0f32.max(min_c[2] + 0.5)
        } else {
            max_c[2]
        };
        let cut_depth = (z_top - min_c[2]).max(1.0);
        let z_bottom_margin = (cut_depth * 0.25).clamp(1.5, 8.0);
        let z_min = if min_c[2] >= 0.0 && min_c[2] < 3.0 {
            // Spoilboard Z=0 convention -> stock rests on Z=0
            0.0
        } else {
            min_c[2] - z_bottom_margin
        };

        StockSpec {
            min: [min_c[0] - pad_xy, min_c[1] - pad_xy, z_min],
            max: [max_c[0] + pad_xy, max_c[1] + pad_xy, z_top],
            inferred: true,
        }
    };

    (stock, tool)
}
