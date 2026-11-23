export type ToolKind =
  | "flat_end_mill"
  | "ball_nose"
  | "tapered_ball_nose"
  | "bull_nose"
  | "v_bit";

export const TOOL_KIND_CODE: Record<ToolKind, number> = {
  flat_end_mill: 0,
  ball_nose: 1,
  tapered_ball_nose: 2,
  bull_nose: 3,
  v_bit: 4,
};

export const TOOL_KIND_LABELS: Record<ToolKind, string> = {
  flat_end_mill: "平底立铣刀",
  ball_nose: "球头铣刀",
  tapered_ball_nose: "锥度球头刀 (浮雕)",
  bull_nose: "圆鼻铣刀",
  v_bit: "V型雕刻刀",
};

export interface ToolSpec {
  id: number;
  kind: ToolKind;
  diameter: number;
  tip_radius: number;
  half_angle_deg: number;
  flute_length: number;
  inferred: boolean;
}

export interface StockSpec {
  min: [number, number, number];
  max: [number, number, number];
  inferred: boolean;
}

export interface ToolpathStats {
  file_name: string;
  file_size_bytes: number;
  total_lines: number;
  segment_count: number;
  rapid_segment_count: number;
  cut_segment_count: number;
  rapid_length_mm: number;
  cut_length_mm: number;
  estimated_time_sec: number;
  parse_time_ms: number;
  cut_bounds_min: [number, number, number];
  cut_bounds_max: [number, number, number];
}

export interface ProgramPayloadDto {
  stats: ToolpathStats;
  stock: StockSpec;
  tool: ToolSpec;
  default_material_id: number;
  preview_lines: string[];
}

export interface ShadersDto {
  sim_wgsl: string;
  studio_part_wgsl: string;
  toolpath_wgsl: string;
}

export interface CameraState {
  yawDeg: number;
  pitchDeg: number;
  zoom: number;
  panX: number;
  panY: number;
  panZ: number;
  ortho?: boolean;
}

export interface SegmentTipInfo {
  x: number;
  y: number;
  z: number;
  lineNumber: number;
  isCut: boolean;
  feedrate: number;
}

export interface FolderFileItem {
  name: string;
  path: string;
  size_bytes: number;
  ext: string;
  browserFile?: File;
}
