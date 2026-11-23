use bytemuck::{Pod, Zeroable};
use serde::{Deserialize, Serialize};

/// Supported 3-axis axially symmetric cutter profiles.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    /// 平底立铣刀
    FlatEndMill = 0,
    /// 球头刀
    BallNose = 1,
    /// 锥度球头刀 (.tap 浮雕精雕主力刀型)
    TaperedBallNose = 2,
    /// 圆鼻刀
    BullNose = 3,
    /// V型雕刻刀 / 倒角刀
    VBit = 4,
}

impl ToolKind {
    pub fn code(self) -> u32 {
        self as u32
    }

    pub fn from_code(code: u32) -> Self {
        match code {
            0 => Self::FlatEndMill,
            1 => Self::BallNose,
            2 => Self::TaperedBallNose,
            3 => Self::BullNose,
            4 => Self::VBit,
            _ => Self::FlatEndMill,
        }
    }

    pub fn label_zh(self) -> &'static str {
        match self {
            Self::FlatEndMill => "平底立铣刀",
            Self::BallNose => "球头铣刀",
            Self::TaperedBallNose => "锥度球头刀",
            Self::BullNose => "圆鼻铣刀",
            Self::VBit => "V型雕刻刀",
        }
    }
}

/// 3-axis cutter geometry specification (canonical units: millimeters & degrees).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolSpec {
    pub id: u32,
    pub kind: ToolKind,
    /// Outer cutting / shank diameter in mm.
    pub diameter: f32,
    /// Tip radius (BallNose = D/2, TaperedBallNose = e.g. 0.5mm, BullNose = corner radius, VBit = tiny flat/tip).
    pub tip_radius: f32,
    /// Per-side taper half-angle in degrees (e.g. 3.5° for TaperedBallNose, 30°/45° for VBit).
    pub half_angle_deg: f32,
    /// Effective flute height in mm.
    pub flute_length: f32,
    /// Whether parameters were heuristically inferred rather than explicitly declared.
    pub inferred: bool,
}

impl ToolSpec {
    /// Height offset dz >= 0 of the cutter envelope above Z_tip at radial distance `r` from spindle axis.
    /// Returns `None` if `r` is outside the cutter's outer radius.
    #[inline]
    pub fn envelope_dz(&self, r: f32) -> Option<f32> {
        let outer_r = (self.diameter * 0.5).max(0.05);
        if r > outer_r {
            return None;
        }
        if r <= 1e-6 {
            return Some(0.0);
        }

        match self.kind {
            ToolKind::FlatEndMill => Some(0.0),
            ToolKind::BallNose => {
                let rad = outer_r;
                let sq = (rad * rad - r * r).max(0.0);
                Some(rad - sq.sqrt())
            }
            ToolKind::BullNose => {
                let cr = self.tip_radius.clamp(0.0, outer_r);
                let flat_r = (outer_r - cr).max(0.0);
                if r <= flat_r || cr <= 1e-5 {
                    Some(0.0)
                } else {
                    let dr = r - flat_r;
                    let sq = (cr * cr - dr * dr).max(0.0);
                    Some(cr - sq.sqrt())
                }
            }
            ToolKind::TaperedBallNose | ToolKind::VBit => {
                let r_tip = self.tip_radius.clamp(0.0, outer_r);
                let alpha = self.half_angle_deg.clamp(0.5, 85.0).to_radians();
                let sin_a = alpha.sin();
                let cos_a = alpha.cos();
                let tan_a = alpha.tan();
                let r_tan = r_tip * cos_a;
                let z_tan = r_tip * (1.0 - sin_a);
                if r <= r_tan && r_tip > 1e-5 {
                    let sq = (r_tip * r_tip - r * r).max(0.0);
                    Some(r_tip - sq.sqrt())
                } else {
                    Some(z_tan + (r - r_tan) / tan_a)
                }
            }
        }
    }
}

/// Workpiece blank (stock) bounding box in mm.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct StockSpec {
    pub min: [f32; 3],
    pub max: [f32; 3],
    pub inferred: bool,
}

impl StockSpec {
    pub fn size(&self) -> [f32; 3] {
        [
            (self.max[0] - self.min[0]).max(0.1),
            (self.max[1] - self.min[1]).max(0.1),
            (self.max[2] - self.min[2]).max(0.1),
        ]
    }

    pub fn center(&self) -> [f32; 3] {
        [
            0.5 * (self.min[0] + self.max[0]),
            0.5 * (self.min[1] + self.max[1]),
            0.5 * (self.min[2] + self.max[2]),
        ]
    }
}

/// GPU-ready 32-byte linear toolpath segment (4-byte scalar fields only -> zero padding mismatch across Rust & WGSL).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Pod, Zeroable, Serialize, Deserialize)]
pub struct GpuSegment {
    pub x0: f32,
    pub y0: f32,
    pub z0: f32,
    /// Bits 0..7: 0 = Rapid (G0), 1 = Cut (G1/G2/G3)
    /// Bits 8..15: tool slot index
    /// Bits 16..31: quantized feedrate (mm/min / 2, clamped to u16)
    pub kind_and_tool: u32,
    pub x1: f32,
    pub y1: f32,
    pub z1: f32,
    /// 1-based G-code source line number
    pub line_number: u32,
}

impl GpuSegment {
    #[inline]
    pub fn new(
        p0: [f32; 3],
        p1: [f32; 3],
        is_cut: bool,
        tool_slot: u8,
        feed_mm_min: f32,
        line_number: u32,
    ) -> Self {
        let kind = if is_cut { 1u32 } else { 0u32 };
        let feed_q = ((feed_mm_min * 0.5).clamp(0.0, 65535.0) as u32) << 16;
        let kind_and_tool = kind | ((tool_slot as u32) << 8) | feed_q;
        Self {
            x0: p0[0],
            y0: p0[1],
            z0: p0[2],
            kind_and_tool,
            x1: p1[0],
            y1: p1[1],
            z1: p1[2],
            line_number,
        }
    }

    #[inline]
    pub fn is_cut(&self) -> bool {
        (self.kind_and_tool & 0xFF) != 0
    }

    #[inline]
    pub fn tool_slot(&self) -> u8 {
        ((self.kind_and_tool >> 8) & 0xFF) as u8
    }

    #[inline]
    pub fn feedrate(&self) -> f32 {
        ((self.kind_and_tool >> 16) as f32) * 2.0
    }
}

/// Summary statistics of a parsed G-code program.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolpathStats {
    pub file_name: String,
    pub file_size_bytes: u64,
    pub total_lines: u32,
    pub segment_count: usize,
    pub rapid_segment_count: usize,
    pub cut_segment_count: usize,
    pub rapid_length_mm: f64,
    pub cut_length_mm: f64,
    pub estimated_time_sec: f64,
    pub parse_time_ms: f64,
    pub cut_bounds_min: [f32; 3],
    pub cut_bounds_max: [f32; 3],
}

/// Complete parsed G-code result ready for simulation and UI inspection.
#[derive(Clone, Debug)]
pub struct ParsedProgram {
    pub segments: Vec<GpuSegment>,
    pub tool: ToolSpec,
    pub stock: StockSpec,
    pub stats: ToolpathStats,
    /// Preview snippet of G-code lines for virtualized UI inspector (capped for huge files, or loaded on demand).
    pub preview_lines: Vec<String>,
}
