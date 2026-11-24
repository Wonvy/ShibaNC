use bytemuck::{Pod, Zeroable};
use serde::{Deserialize, Serialize};
use shibanc_gcode::ToolKind;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaterialPreset {
    Aluminum6061 = 0,
    Rosewood = 1,
    Brass = 2,
    Jade = 3,
    PineWood = 4,
    DepthHeatmap = 5,
    MdfBoard = 6,
    BirchPlywood = 7,
}

impl MaterialPreset {
    pub fn id(self) -> u32 {
        self as u32
    }

    pub fn from_id(id: u32) -> Self {
        match id {
            0 => Self::Aluminum6061,
            1 => Self::Rosewood,
            2 => Self::Brass,
            3 => Self::Jade,
            4 => Self::PineWood,
            5 => Self::DepthHeatmap,
            6 => Self::MdfBoard,
            7 => Self::BirchPlywood,
            _ => Self::MdfBoard,
        }
    }

    pub fn auto_for_tool(_kind: ToolKind, _file_ext: &str) -> Self {
        Self::MdfBoard
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RenderOptions {
    pub width: u32,
    pub height: u32,
    /// Heightfield resolution along longest stock axis (e.g. 512 for fast thumbnail, 1024..2048 for HD export).
    pub grid_max_dim: u32,
    pub material: Option<MaterialPreset>,
    pub show_cuts_overlay: bool,
    pub show_rapids_overlay: bool,
    pub show_cutter: bool,
    pub show_floor: bool,
    pub show_solid: bool,
    pub yaw_deg: f32,
    pub pitch_deg: f32,
    pub zoom: f32,
    /// Optional step limit (None = full program).
    pub active_segments: Option<usize>,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            width: 1024,
            height: 768,
            grid_max_dim: 1024,
            material: None,
            show_cuts_overlay: false,
            show_rapids_overlay: false,
            show_cutter: false,
            show_floor: true,
            show_solid: true,
            yaw_deg: -36.0,
            pitch_deg: 46.0,
            zoom: 1.0,
            active_segments: None,
        }
    }
}

impl RenderOptions {
    pub fn for_os_thumbnail(size: u32) -> Self {
        let clamped = size.clamp(64, 1024);
        Self {
            width: clamped,
            height: clamped,
            grid_max_dim: if clamped <= 256 { 448 } else { 640 },
            material: None,
            show_cuts_overlay: false,
            show_rapids_overlay: false,
            show_cutter: false,
            show_floor: false,
            show_solid: true,
            yaw_deg: -34.0,
            pitch_deg: 48.0,
            zoom: 1.12,
            active_segments: None,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct SimParamsGpu {
    pub stock_min_x: f32,
    pub stock_min_y: f32,
    pub stock_min_z: f32,
    pub stock_max_z: f32,

    pub stock_max_x: f32,
    pub stock_max_y: f32,
    pub cell_dx: f32,
    pub cell_dy: f32,

    pub grid_w: u32,
    pub grid_h: u32,
    pub active_seg_count: u32,
    pub seg_offset: u32,

    pub tool_kind: u32,
    pub tool_outer_r: f32,
    pub tool_tip_r: f32,
    pub tool_half_angle_rad: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct RenderUniformsGpu {
    pub view_proj: [[f32; 4]; 4],
    pub camera_pos: [f32; 4],
    pub stock_min: [f32; 4],
    pub stock_max: [f32; 4],
    pub grid_info: [f32; 4],
    pub style_info: [f32; 4],
    pub cutter_pos: [f32; 4],
    pub cutter_geom: [f32; 4],
    pub section_info: [f32; 4],
    pub roi_bounds: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct LineUniformsGpu {
    pub view_proj: [[f32; 4]; 4],
    pub opts: [f32; 4],
    pub stock_min: [f32; 4],
    pub stock_max: [f32; 4],
    pub wcs_origin: [f32; 4],
}
