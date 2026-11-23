// Shared 3-Axis CNC Material Removal Compute Shader (WGSL)
// Runs identically in Rust `wgpu` (DX12/Metal/Vulkan) and Desktop WebGPU.

const Z_SCALE: f32 = 10000.0; // 0.1 micrometer fixed-point precision

struct SimParams {
    stock_min_x: f32,
    stock_min_y: f32,
    stock_min_z: f32,
    stock_max_z: f32,

    stock_max_x: f32,
    stock_max_y: f32,
    cell_dx: f32,
    cell_dy: f32,

    grid_w: u32,
    grid_h: u32,
    active_seg_count: u32,
    seg_offset: u32,

    // tool_kind: 0=Flat, 1=Ball, 2=TaperedBall, 3=BullNose, 4=VBit
    tool_kind: u32,
    tool_outer_r: f32,
    tool_tip_r: f32,
    tool_half_angle_rad: f32,
};

struct GpuSegment {
    x0: f32,
    y0: f32,
    z0: f32,
    kind_and_tool: u32,
    x1: f32,
    y1: f32,
    z1: f32,
    line_number: u32,
};

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read> segments: array<GpuSegment>;
@group(0) @binding(2) var<storage, read_write> heights: array<atomic<i32>>;

fn tool_envelope_dz(r: f32) -> f32 {
    if (r <= 1e-6) {
        return 0.0;
    }
    let outer_r = params.tool_outer_r;
    switch (params.tool_kind) {
        case 0u: {
            // FlatEndMill
            return 0.0;
        }
        case 1u: {
            // BallNose
            let sq = max(outer_r * outer_r - r * r, 0.0);
            return outer_r - sqrt(sq);
        }
        case 3u: {
            // BullNose
            let cr = clamp(params.tool_tip_r, 0.0, outer_r);
            let flat_r = max(outer_r - cr, 0.0);
            if (r <= flat_r || cr <= 1e-5) {
                return 0.0;
            }
            let dr = r - flat_r;
            let sq = max(cr * cr - dr * dr, 0.0);
            return cr - sqrt(sq);
        }
        case 2u, 4u: {
            // TaperedBallNose & VBit (C1 tangent sphere-to-cone profile)
            let r_tip = clamp(params.tool_tip_r, 0.0, outer_r);
            let alpha = clamp(params.tool_half_angle_rad, 0.008, 1.48);
            let sin_a = sin(alpha);
            let cos_a = cos(alpha);
            let tan_a = tan(alpha);
            let r_tan = r_tip * cos_a;
            let z_tan = r_tip * (1.0 - sin_a);
            if (r <= r_tan && r_tip > 1e-5) {
                let sq = max(r_tip * r_tip - r * r, 0.0);
                return r_tip - sqrt(sq);
            }
            return z_tan + (r - r_tan) / tan_a;
        }
        default: {
            return 0.0;
        }
    }
}

fn eval_swept_z(qx: f32, qy: f32, seg: GpuSegment, t: f32) -> f32 {
    let cx = seg.x0 + t * (seg.x1 - seg.x0);
    let cy = seg.y0 + t * (seg.y1 - seg.y0);
    let cz = seg.z0 + t * (seg.z1 - seg.z0);
    let dx = qx - cx;
    let dy = qy - cy;
    let r = sqrt(dx * dx + dy * dy);
    return cz + tool_envelope_dz(r);
}

@compute @workgroup_size(16, 16, 1)
fn init_stock_grid(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= params.grid_w || gid.y >= params.grid_h) {
        return;
    }
    let idx = gid.y * params.grid_w + gid.x;
    let z_init = i32(round(params.stock_max_z * Z_SCALE));
    atomicStore(&heights[idx], z_init);
}

@compute @workgroup_size(64, 1, 1)
fn carve_segments(@builtin(global_invocation_id) gid: vec3<u32>) {
    let seg_idx = params.seg_offset + gid.x;
    if (seg_idx >= params.active_seg_count) {
        return;
    }

    let seg = segments[seg_idx];
    // Only G1/G2/G3 cutting segments remove material (or rapid crashes below stock_max_z!)
    let is_cut = (seg.kind_and_tool & 255u) != 0u;
    if (!is_cut && min(seg.z0, seg.z1) >= params.stock_max_z) {
        return;
    }

    let outer_r = max(params.tool_outer_r, 0.05);
    let min_x = min(seg.x0, seg.x1) - outer_r;
    let max_x = max(seg.x0, seg.x1) + outer_r;
    let min_y = min(seg.y0, seg.y1) - outer_r;
    let max_y = max(seg.y0, seg.y1) + outer_r;

    if (max_x < params.stock_min_x || min_x > params.stock_max_x ||
        max_y < params.stock_min_y || min_y > params.stock_max_y) {
        return;
    }

    let ix0 = u32(clamp(floor((min_x - params.stock_min_x) / params.cell_dx), 0.0, f32(params.grid_w - 1u)));
    let ix1 = u32(clamp(ceil((max_x - params.stock_min_x) / params.cell_dx), 0.0, f32(params.grid_w - 1u)));
    let iy0 = u32(clamp(floor((min_y - params.stock_min_y) / params.cell_dy), 0.0, f32(params.grid_h - 1u)));
    let iy1 = u32(clamp(ceil((max_y - params.stock_min_y) / params.cell_dy), 0.0, f32(params.grid_h - 1u)));

    let dx = seg.x1 - seg.x0;
    let dy = seg.y1 - seg.y0;
    let dz = seg.z1 - seg.z0;
    let len2 = dx * dx + dy * dy;
    let r2 = outer_r * outer_r;
    let pierce_floor = params.stock_min_z - 0.25;

    for (var iy: u32 = iy0; iy <= iy1; iy = iy + 1u) {
        let qy = params.stock_min_y + f32(iy) * params.cell_dy;
        let row_offset = iy * params.grid_w;

        for (var ix: u32 = ix0; ix <= ix1; ix = ix + 1u) {
            let qx = params.stock_min_x + f32(ix) * params.cell_dx;

            var best_z: f32 = 1e9;

            if (len2 < 1e-8) {
                // Pure vertical plunge
                let vx = qx - seg.x0;
                let vy = qy - seg.y0;
                let d2 = vx * vx + vy * vy;
                if (d2 > r2) {
                    continue;
                }
                best_z = min(seg.z0, seg.z1) + tool_envelope_dz(sqrt(d2));
            } else {
                let vx = qx - seg.x0;
                let vy = qy - seg.y0;
                let t_free = (vx * dx + vy * dy) / len2;
                let t_perp = clamp(t_free, 0.0, 1.0);
                let rx = qx - (seg.x0 + t_perp * dx);
                let ry = qy - (seg.y0 + t_perp * dy);
                let d2_min = rx * rx + ry * ry;
                if (d2_min > r2) {
                    continue;
                }

                if (abs(dz) < 1e-5) {
                    // Horizontal cut in XY: minimum Z is strictly at closest radial point
                    best_z = seg.z0 + tool_envelope_dz(sqrt(d2_min));
                } else {
                    // Exact valid parameter interval [ta, tb] where cutter overlaps (qx, qy)
                    let d2_line = max(vx * vx + vy * vy - t_free * t_free * len2, 0.0);
                    let dt_max = sqrt(max(r2 - d2_line, 0.0) / len2);
                    var ta = clamp(t_free - dt_max, 0.0, 1.0);
                    var tb = clamp(t_free + dt_max, 0.0, 1.0);

                    if (params.tool_kind == 0u) {
                        // FlatEndMill: minimum is exact at lower-Z endpoint of [ta, tb]
                        let za = seg.z0 + ta * dz;
                        let zb = seg.z0 + tb * dz;
                        best_z = min(za, zb);
                    } else {
                        // Strictly convex swept envelope on [ta, tb] -> 6-step golden/ternary search
                        best_z = min(eval_swept_z(qx, qy, seg, ta), eval_swept_z(qx, qy, seg, tb));
                        best_z = min(best_z, eval_swept_z(qx, qy, seg, clamp(t_free, ta, tb)));
                        for (var it: u32 = 0u; it < 6u; it = it + 1u) {
                            let m1 = ta + (tb - ta) * 0.381966;
                            let m2 = ta + (tb - ta) * 0.618034;
                            let z1 = eval_swept_z(qx, qy, seg, m1);
                            let z2 = eval_swept_z(qx, qy, seg, m2);
                            if (z1 < z2) {
                                best_z = min(best_z, z1);
                                tb = m2;
                            } else {
                                best_z = min(best_z, z2);
                                ta = m1;
                            }
                        }
                    }
                }
            }

            if (best_z < params.stock_max_z) {
                let z_clamped = max(best_z, pierce_floor);
                let z_int = i32(round(z_clamped * Z_SCALE));
                atomicMin(&heights[row_offset + ix], z_int);
            }
        }
    }
}
