// Shared Studio PBR + MatCap + Exact Heightfield Horizon AO Shader (WGSL)
// Renders watertight 3-axis machined block (Top Machined Surface + Side Skirt + Bottom + 3D Cutter)

const Z_SCALE: f32 = 10000.0;
const PI: f32 = 3.14159265359;

struct RenderUniforms {
    view_proj: mat4x4<f32>,
    camera_pos: vec4<f32>,
    stock_min: vec4<f32>,
    stock_max: vec4<f32>,
    // x = grid_w, y = grid_h, z = cell_dx, w = cell_dy
    grid_info: vec4<f32>,
    // x = material_id (0=Alu6061, 1=Rosewood, 2=Brass, 3=Jade, 4=Pine, 5=DepthHeatmap)
    // y = pass_kind (0=TopSurface, 1=OuterSkirt, 2=BottomCap, 3=CutterMesh, 4=FloorGrid, 5=SectionCap)
    // z = ao_strength
    // w = reserved
    style_info: vec4<f32>,
    // x = tool_x, y = tool_y, z = tool_z, w = tool_outer_r
    cutter_pos: vec4<f32>,
    // x = tool_kind, y = tool_tip_r, z = tool_half_angle_rad, w = tool_flute_len
    cutter_geom: vec4<f32>,
    // x = section_axis (0=Off, 1=X-Cut keeping x >= pos, 2=Y-Cut keeping y >= pos)
    // y = section_pos (world mm)
    // z = roi_mode (0=normal, 1=base_skip_roi, 2=draw_roi_patch)
    // w = reserved
    section_info: vec4<f32>,
    // x = roi_min_x, y = roi_min_y, z = roi_max_x, w = roi_max_y
    roi_bounds: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: RenderUniforms;
@group(0) @binding(1) var<storage, read> heights: array<i32>;

struct VsOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) grid_uv: vec2<f32>,
    @location(3) raw_z: f32,
    @location(4) @interpolate(flat) part_zone: u32, // 0=machined_top, 1=side_or_bottom, 2=cutter_flute, 3=cutter_shank, 4=floor
};

fn read_raw_z(ix: i32, iy: i32) -> f32 {
    let gw = i32(u.grid_info.x);
    let gh = i32(u.grid_info.y);
    let cx = clamp(ix, 0, gw - 1);
    let cy = clamp(iy, 0, gh - 1);
    return f32(heights[cy * gw + cx]) / Z_SCALE;
}

fn read_clamped_z(ix: i32, iy: i32) -> f32 {
    return clamp(read_raw_z(ix, iy), u.stock_min.z, u.stock_max.z);
}

fn sample_raw_z_world(wx: f32, wy: f32) -> f32 {
    let gw = i32(u.grid_info.x);
    let gh = i32(u.grid_info.y);
    let fx = clamp((wx - u.stock_min.x) / max(u.grid_info.z, 1e-5), 0.0, f32(gw - 1));
    let fy = clamp((wy - u.stock_min.y) / max(u.grid_info.w, 1e-5), 0.0, f32(gh - 1));
    let ix = min(i32(floor(fx)), gw - 2);
    let iy = min(i32(floor(fy)), gh - 2);
    let tx = fx - f32(ix);
    let ty = fy - f32(iy);
    let z00 = read_raw_z(ix, iy);
    let z10 = read_raw_z(ix + 1, iy);
    let z01 = read_raw_z(ix, iy + 1);
    let z11 = read_raw_z(ix + 1, iy + 1);
    return mix(mix(z00, z10, tx), mix(z01, z11, tx), ty);
}

fn grid_world_pos(ix: i32, iy: i32) -> vec3<f32> {
    return vec3<f32>(
        u.stock_min.x + f32(ix) * u.grid_info.z,
        u.stock_min.y + f32(iy) * u.grid_info.w,
        read_clamped_z(ix, iy)
    );
}

// Crease-aware central difference normal: preserves razor-sharp 90° ledges while smoothing curved reliefs!
fn compute_crease_normal(ix: i32, iy: i32, tri_normal: vec3<f32>) -> vec3<f32> {
    // Steep vertical/tapered walls use crisp geometric triangle normal
    if (tri_normal.z < 0.68) {
        return tri_normal;
    }
    let dx = u.grid_info.z;
    let dy = u.grid_info.w;
    let zc = read_clamped_z(ix, iy);
    let zl_raw = read_clamped_z(ix - 1, iy);
    let zr_raw = read_clamped_z(ix + 1, iy);
    let zd_raw = read_clamped_z(ix, iy - 1);
    let zu_raw = read_clamped_z(ix, iy + 1);

    let cliff_thresh = max(dx, dy) * 2.2;
    let zl = select(zl_raw, zc, abs(zl_raw - zc) > cliff_thresh);
    let zr = select(zr_raw, zc, abs(zr_raw - zc) > cliff_thresh);
    let zd = select(zd_raw, zc, abs(zd_raw - zc) > cliff_thresh);
    let zu = select(zu_raw, zc, abs(zu_raw - zc) > cliff_thresh);

    let span_x = select(2.0 * dx, dx, zl == zc || zr == zc);
    let span_y = select(2.0 * dy, dy, zd == zc || zu == zc);
    let dzdx = (zr - zl) / max(span_x, 1e-5);
    let dzdy = (zu - zd) / max(span_y, 1e-5);
    return normalize(vec3<f32>(-dzdx, -dzdy, 1.0));
}

fn cutter_profile_r_and_z(v_norm: f32) -> vec2<f32> {
    // v_norm in [0, 1]: 0..0.65 = cutting flute, 0.65..1.0 = upper shank/holder
    let outer_r = max(u.cutter_pos.w, 0.2);
    let kind = u32(round(u.cutter_geom.x));
    let tip_r = clamp(u.cutter_geom.y, 0.0, outer_r);
    let alpha = clamp(u.cutter_geom.z, 0.008, 1.48);
    let flute_h = max(u.cutter_geom.w, outer_r * 3.0);

    if (v_norm <= 0.65) {
        let t = v_norm / 0.65;
        let z_local = t * flute_h;
        var r_local = outer_r;
        if (kind == 1u) {
            // BallNose
            if (z_local < outer_r) {
                let dz = outer_r - z_local;
                r_local = sqrt(max(outer_r * outer_r - dz * dz, 0.0));
            }
        } else if (kind == 3u) {
            // BullNose
            if (z_local < tip_r && tip_r > 1e-4) {
                let dz = tip_r - z_local;
                r_local = (outer_r - tip_r) + sqrt(max(tip_r * tip_r - dz * dz, 0.0));
            }
        } else if (kind == 2u || kind == 4u) {
            // TaperedBallNose / VBit
            let z_tan = tip_r * (1.0 - sin(alpha));
            let r_tan = tip_r * cos(alpha);
            if (z_local <= z_tan && tip_r > 1e-4) {
                let dz = tip_r - z_local;
                r_local = sqrt(max(tip_r * tip_r - dz * dz, 0.0));
            } else {
                r_local = min(r_tan + (z_local - z_tan) * tan(alpha), outer_r * 1.6);
            }
        }
        if (v_norm <= 0.001) {
            r_local = 0.0;
        }
        return vec2<f32>(r_local, z_local);
    } else {
        // Cylindrical shank + collet step
        let t_shank = (v_norm - 0.65) / 0.35;
        let collet_scale = select(1.0, 1.65, t_shank > 0.55);
        let z_local = flute_h + t_shank * (flute_h * 0.65);
        let r_local = select(outer_r * collet_scale, 0.0, v_norm >= 0.999);
        return vec2<f32>(r_local, z_local);
    }
}

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
    var out: VsOut;
    let pass_kind = u32(round(u.style_info.y));
    let gw = i32(u.grid_info.x);
    let gh = i32(u.grid_info.y);
    let cells_x = gw - 1;
    let cells_y = gh - 1;

    if (pass_kind == 0u) {
        // Top Machined Surface
        let quad_idx = i32(vid / 6u);
        let corner = vid % 6u;
        let qx = quad_idx % cells_x;
        let qy = quad_idx / cells_x;

        // Exact zero-z-fight quad culling when Ultra-HD ROI patch covers [ix0..ix1, iy0..iy1]
        if (u32(round(u.section_info.z)) == 1u) {
            let r_ix0 = i32(round(u.roi_bounds.x));
            let r_iy0 = i32(round(u.roi_bounds.y));
            let r_ix1 = i32(round(u.roi_bounds.z));
            let r_iy1 = i32(round(u.roi_bounds.w));
            if (qx >= r_ix0 && qx < r_ix1 && qy >= r_iy0 && qy < r_iy1) {
                out.clip_pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
                out.world_pos = vec3<f32>(0.0);
                out.normal = vec3<f32>(0.0, 0.0, 1.0);
                out.grid_uv = vec2<f32>(0.0);
                out.raw_z = u.stock_max.z;
                out.part_zone = 0u;
                return out;
            }
        }

        let p00 = grid_world_pos(qx, qy);
        let p10 = grid_world_pos(qx + 1, qy);
        let p01 = grid_world_pos(qx, qy + 1);
        let p11 = grid_world_pos(qx + 1, qy + 1);

        var ox: i32 = 0;
        var oy: i32 = 0;
        var tri_n: vec3<f32>;

        // Split quad along shorter Z diagonal to avoid diagonal stair-stepping on circular pockets!
        let diag_a = abs(p11.z - p00.z);
        let diag_b = abs(p10.z - p01.z);

        if (diag_a <= diag_b) {
            // Triangles: (00, 10, 11) and (00, 11, 01)
            switch (corner) {
                case 0u: { ox = 0; oy = 0; tri_n = normalize(cross(p10 - p00, p11 - p00)); }
                case 1u: { ox = 1; oy = 0; tri_n = normalize(cross(p10 - p00, p11 - p00)); }
                case 2u: { ox = 1; oy = 1; tri_n = normalize(cross(p10 - p00, p11 - p00)); }
                case 3u: { ox = 0; oy = 0; tri_n = normalize(cross(p11 - p00, p01 - p00)); }
                case 4u: { ox = 1; oy = 1; tri_n = normalize(cross(p11 - p00, p01 - p00)); }
                default: { ox = 0; oy = 1; tri_n = normalize(cross(p11 - p00, p01 - p00)); }
            }
        } else {
            // Triangles: (00, 10, 01) and (10, 11, 01)
            switch (corner) {
                case 0u: { ox = 0; oy = 0; tri_n = normalize(cross(p10 - p00, p01 - p00)); }
                case 1u: { ox = 1; oy = 0; tri_n = normalize(cross(p10 - p00, p01 - p00)); }
                case 2u: { ox = 0; oy = 1; tri_n = normalize(cross(p10 - p00, p01 - p00)); }
                case 3u: { ox = 1; oy = 0; tri_n = normalize(cross(p11 - p10, p01 - p10)); }
                case 4u: { ox = 1; oy = 1; tri_n = normalize(cross(p11 - p10, p01 - p10)); }
                default: { ox = 0; oy = 1; tri_n = normalize(cross(p11 - p10, p01 - p10)); }
            }
        }

        let ix = qx + ox;
        let iy = qy + oy;
        let wp = grid_world_pos(ix, iy);
        out.world_pos = wp;
        out.normal = compute_crease_normal(ix, iy, tri_n);
        out.grid_uv = vec2<f32>(f32(ix), f32(iy));
        out.raw_z = read_raw_z(ix, iy);
        out.part_zone = 0u;
        out.clip_pos = u.view_proj * vec4<f32>(wp, 1.0);
        return out;
    } else if (pass_kind == 1u) {
        // Watertight Stock Perimeter Skirt (4 sides: South y=0, North y=gh-1, West x=0, East x=gw-1)
        let seg_idx = i32(vid / 6u);
        let corner = vid % 6u;
        let n_south = cells_x;
        let n_north = cells_x;
        let n_west = cells_y;

        var ix0: i32 = 0; var iy0: i32 = 0;
        var ix1: i32 = 0; var iy1: i32 = 0;
        var wall_n = vec3<f32>(0.0, -1.0, 0.0);

        if (seg_idx < n_south) {
            let s = seg_idx;
            ix0 = s; iy0 = 0; ix1 = s + 1; iy1 = 0;
            wall_n = vec3<f32>(0.0, -1.0, 0.0);
        } else if (seg_idx < n_south + n_north) {
            let s = seg_idx - n_south;
            ix0 = s + 1; iy0 = gh - 1; ix1 = s; iy1 = gh - 1;
            wall_n = vec3<f32>(0.0, 1.0, 0.0);
        } else if (seg_idx < n_south + n_north + n_west) {
            let s = seg_idx - n_south - n_north;
            ix0 = 0; iy0 = s + 1; ix1 = 0; iy1 = s;
            wall_n = vec3<f32>(-1.0, 0.0, 0.0);
        } else {
            let s = seg_idx - n_south - n_north - n_west;
            ix0 = gw - 1; iy0 = s; ix1 = gw - 1; iy1 = s + 1;
            wall_n = vec3<f32>(1.0, 0.0, 0.0);
        }

        let top0 = grid_world_pos(ix0, iy0);
        let top1 = grid_world_pos(ix1, iy1);
        let bot0 = vec3<f32>(top0.x, top0.y, u.stock_min.z);
        let bot1 = vec3<f32>(top1.x, top1.y, u.stock_min.z);

        var wp = bot0;
        switch (corner) {
            case 0u: { wp = bot0; }
            case 1u: { wp = bot1; }
            case 2u: { wp = top1; }
            case 3u: { wp = bot0; }
            case 4u: { wp = top1; }
            default: { wp = top0; }
        }
        out.world_pos = wp;
        out.normal = wall_n;
        out.grid_uv = vec2<f32>(f32(ix0), f32(iy0));
        out.raw_z = u.stock_max.z;
        out.part_zone = 1u;
        out.clip_pos = u.view_proj * vec4<f32>(wp, 1.0);
        return out;
    } else if (pass_kind == 2u) {
        // Bottom Cap (with matching through-hole piercing!)
        let quad_idx = i32(vid / 6u);
        let corner = vid % 6u;
        let qx = quad_idx % cells_x;
        let qy = quad_idx / cells_x;

        var ox: i32 = 0;
        var oy: i32 = 0;
        // Reversed winding facing -Z
        switch (corner) {
            case 0u: { ox = 0; oy = 0; }
            case 1u: { ox = 1; oy = 1; }
            case 2u: { ox = 1; oy = 0; }
            case 3u: { ox = 0; oy = 0; }
            case 4u: { ox = 0; oy = 1; }
            default: { ox = 1; oy = 1; }
        }
        let ix = qx + ox;
        let iy = qy + oy;
        let wp = vec3<f32>(
            u.stock_min.x + f32(ix) * u.grid_info.z,
            u.stock_min.y + f32(iy) * u.grid_info.w,
            u.stock_min.z
        );
        out.world_pos = wp;
        out.normal = vec3<f32>(0.0, 0.0, -1.0);
        out.grid_uv = vec2<f32>(f32(ix), f32(iy));
        out.raw_z = read_raw_z(ix, iy);
        out.part_zone = 1u;
        out.clip_pos = u.view_proj * vec4<f32>(wp, 1.0);
        return out;
    } else if (pass_kind == 3u) {
        // Procedural 3D Revolved Cutter + Shank (32 slices x 24 stacks)
        let slices = 32u;
        let stacks = 24u;
        let quad_idx = vid / 6u;
        let corner = vid % 6u;
        let si = quad_idx % slices;
        let ti = quad_idx / slices;

        var ds = 0u;
        var dt = 0u;
        switch (corner) {
            case 0u: { ds = 0u; dt = 0u; }
            case 1u: { ds = 1u; dt = 0u; }
            case 2u: { ds = 1u; dt = 1u; }
            case 3u: { ds = 0u; dt = 0u; }
            case 4u: { ds = 1u; dt = 1u; }
            default: { ds = 0u; dt = 1u; }
        }

        let u_ang = f32(si + ds) / f32(slices) * (2.0 * PI);
        let v_norm = f32(ti + dt) / f32(stacks);
        var rz = cutter_profile_r_and_z(v_norm);
        let rz_next = cutter_profile_r_and_z(clamp(v_norm + 0.02, 0.0, 0.99));
        let dr = rz_next.x - rz.x;
        let dz = max(rz_next.y - rz.y, 1e-4);

        // Sculpt subtle 4-flute helical groove relief along the cutting flute
        if (v_norm > 0.03 && v_norm <= 0.63) {
            let flute_wave = 0.5 + 0.5 * cos(u_ang * 4.0 - v_norm * 18.0);
            rz.x = rz.x * (0.90 + 0.10 * flute_wave);
        }

        let ca = cos(u_ang);
        let sa = sin(u_ang);
        let wp = vec3<f32>(
            u.cutter_pos.x + rz.x * ca,
            u.cutter_pos.y + rz.x * sa,
            u.cutter_pos.z + rz.y
        );
        var n_rad = normalize(vec3<f32>(dz * ca, dz * sa, -dr));
        if (v_norm >= 0.95) {
            n_rad = vec3<f32>(0.0, 0.0, 1.0);
        } else if (v_norm <= 0.005) {
            n_rad = vec3<f32>(0.0, 0.0, -1.0);
        }
        out.world_pos = wp;
        out.normal = n_rad;
        out.grid_uv = vec2<f32>(u_ang, v_norm);
        out.raw_z = wp.z;
        out.part_zone = select(2u, 3u, v_norm > 0.65);
        out.clip_pos = u.view_proj * vec4<f32>(wp, 1.0);
        return out;
    } else if (pass_kind == 5u) {
        // Solid Cross-Section Cut Wall along X = section_pos or Y = section_pos
        let sec_axis = u32(round(u.section_info.x));
        let sec_pos = u.section_info.y;
        let seg_idx = i32(vid / 6u);
        let corner = vid % 6u;

        var top0 = vec3<f32>(0.0);
        var top1 = vec3<f32>(0.0);
        var raw0 = u.stock_max.z;
        var raw1 = u.stock_max.z;
        var sec_n = vec3<f32>(-1.0, 0.0, 0.0);

        if (sec_axis == 1u) {
            // X-Section plane (spans Y from 0..cells_y, normal faces -X toward viewer)
            let s = clamp(seg_idx, 0, cells_y - 1);
            let y0 = u.stock_min.y + f32(s) * u.grid_info.w;
            let y1 = u.stock_min.y + f32(s + 1) * u.grid_info.w;
            raw0 = sample_raw_z_world(sec_pos, y0);
            raw1 = sample_raw_z_world(sec_pos, y1);
            top0 = vec3<f32>(sec_pos, y0, clamp(raw0, u.stock_min.z, u.stock_max.z));
            top1 = vec3<f32>(sec_pos, y1, clamp(raw1, u.stock_min.z, u.stock_max.z));
            sec_n = vec3<f32>(-1.0, 0.0, 0.0);
        } else {
            // Y-Section plane (spans X from 0..cells_x, normal faces -Y toward viewer)
            let s = clamp(seg_idx, 0, cells_x - 1);
            let x0 = u.stock_min.x + f32(s) * u.grid_info.z;
            let x1 = u.stock_min.x + f32(s + 1) * u.grid_info.z;
            raw0 = sample_raw_z_world(x0, sec_pos);
            raw1 = sample_raw_z_world(x1, sec_pos);
            top0 = vec3<f32>(x0, sec_pos, clamp(raw0, u.stock_min.z, u.stock_max.z));
            top1 = vec3<f32>(x1, sec_pos, clamp(raw1, u.stock_min.z, u.stock_max.z));
            sec_n = vec3<f32>(0.0, -1.0, 0.0);
        }

        let bot0 = vec3<f32>(top0.x, top0.y, u.stock_min.z);
        let bot1 = vec3<f32>(top1.x, top1.y, u.stock_min.z);
        var wp = bot0;
        var rz_val = raw0;
        switch (corner) {
            case 0u: { wp = bot0; rz_val = raw0; }
            case 1u: { wp = bot1; rz_val = raw1; }
            case 2u: { wp = top1; rz_val = raw1; }
            case 3u: { wp = bot0; rz_val = raw0; }
            case 4u: { wp = top1; rz_val = raw1; }
            default: { wp = top0; rz_val = raw0; }
        }
        out.world_pos = wp;
        out.normal = sec_n;
        out.grid_uv = vec2<f32>(0.0, 0.0);
        out.raw_z = rz_val;
        out.part_zone = 5u;
        out.clip_pos = u.view_proj * vec4<f32>(wp, 1.0);
        return out;
    } else {
        // Subtle Reference Floor Plane (6 vertices)
        let cx = 0.5 * (u.stock_min.x + u.stock_max.x);
        let cy = 0.5 * (u.stock_min.y + u.stock_max.y);
        let span = max(u.stock_max.x - u.stock_min.x, u.stock_max.y - u.stock_min.y) * 1.45;
        let z_floor = u.stock_min.z - 0.15;
        var uv = vec2<f32>(-1.0, -1.0);
        switch (vid % 6u) {
            case 0u: { uv = vec2<f32>(-1.0, -1.0); }
            case 1u: { uv = vec2<f32>( 1.0, -1.0); }
            case 2u: { uv = vec2<f32>( 1.0,  1.0); }
            case 3u: { uv = vec2<f32>(-1.0, -1.0); }
            case 4u: { uv = vec2<f32>( 1.0,  1.0); }
            default: { uv = vec2<f32>(-1.0,  1.0); }
        }
        let wp = vec3<f32>(cx + uv.x * span, cy + uv.y * span, z_floor);
        out.world_pos = wp;
        out.normal = vec3<f32>(0.0, 0.0, 1.0);
        out.grid_uv = uv;
        out.raw_z = z_floor;
        out.part_zone = 4u;
        out.clip_pos = u.view_proj * vec4<f32>(wp, 1.0);
        return out;
    }
}

// Exact Heightfield Multi-Scale Horizon Ambient Occlusion (flicker-free deep pocket & relief shadowing)
fn compute_heightfield_ao(grid_uv: vec2<f32>, center_z: f32) -> f32 {
    let strength = u.style_info.z;
    if (strength <= 0.01) {
        return 1.0;
    }
    let ix = i32(round(grid_uv.x));
    let iy = i32(round(grid_uv.y));
    let cell_size = 0.5 * (u.grid_info.z + u.grid_info.w);

    let dirs = array<vec2<i32>, 8>(
        vec2<i32>( 1,  0), vec2<i32>(-1,  0),
        vec2<i32>( 0,  1), vec2<i32>( 0, -1),
        vec2<i32>( 1,  1), vec2<i32>(-1, -1),
        vec2<i32>( 1, -1), vec2<i32>(-1,  1)
    );
    let radii = array<i32, 3>(2, 6, 16);
    let step_mul = max(i32(round(u.section_info.w)), 1);

    var occ: f32 = 0.0;
    for (var d: u32 = 0u; d < 8u; d = d + 1u) {
        let dir = dirs[d];
        let diag_scale = select(1.0, 1.4142, dir.x != 0 && dir.y != 0);
        var max_slope: f32 = 0.0;
        for (var r_idx: u32 = 0u; r_idx < 3u; r_idx = r_idx + 1u) {
            let step_r = radii[r_idx] * step_mul;
            let sz = read_clamped_z(ix + dir.x * step_r, iy + dir.y * step_r);
            let dz = sz - center_z;
            if (dz > 0.0) {
                let dist = f32(step_r) * cell_size * diag_scale;
                max_slope = max(max_slope, dz / max(dist, 1e-4));
            }
        }
        occ = occ + (max_slope / (1.0 + max_slope));
    }
    let ao_raw = 1.0 - (occ / 8.0) * 0.88 * strength;
    return clamp(ao_raw, 0.18, 1.0);
}

fn wood_grain_albedo(wp: vec3<f32>) -> vec3<f32> {
    // Rich reddish-brown Burmese Rosewood (花梨木) block grain
    let p = wp * vec3<f32>(0.09, 0.035, 0.24);
    let wobble = sin(p.x * 2.1 + p.y * 3.2) * 0.36 + cos(p.y * 4.6 - p.z * 1.5) * 0.20;
    let ring_dist = length(vec2<f32>(p.x + 14.0, p.z * 1.4 + 9.0)) * 2.2 + wobble;
    let ring = 0.5 + 0.5 * sin(ring_dist * 6.28318);
    let pore = 0.5 + 0.5 * sin(wp.x * 18.0 + wp.y * 2.8);
    let early_wood = vec3<f32>(0.62, 0.36, 0.20);
    let late_wood  = vec3<f32>(0.42, 0.22, 0.11);
    return mix(early_wood, late_wood, smoothstep(0.22, 0.85, ring)) * (0.96 + 0.04 * pore);
}

fn pine_wood_albedo(wp: vec3<f32>) -> vec3<f32> {
    // Creamy-blonde natural Pine Wood (松木): wide pale-straw earlywood + narrower golden-amber latewood rings
    let p = wp * vec3<f32>(0.068, 0.024, 0.19);
    let wobble = sin(p.x * 1.6 + p.y * 2.4) * 0.42 + cos(p.y * 3.6 + p.z * 1.2) * 0.22;
    let ring_dist = length(vec2<f32>(p.x + 18.0, p.z * 1.35 + 11.0)) * 1.85 + wobble;
    let wave = 0.5 + 0.5 * sin(ring_dist * 6.28318);
    // Sharper summerwood transition characteristic of softwood pine
    let late_band = smoothstep(0.62, 0.94, wave);
    let fiber = 0.5 + 0.5 * sin(wp.y * 9.0 + wp.x * 2.2);
    let early_pine = vec3<f32>(0.91, 0.81, 0.63);
    let late_pine  = vec3<f32>(0.73, 0.53, 0.32);
    return mix(early_pine, late_pine, late_band) * (0.98 + 0.02 * fiber);
}

fn mdf_board_albedo(wp: vec3<f32>, is_uncut_top: bool) -> vec3<f32> {
    // Medium-Density Fiberboard (密度板 MDF): smooth pressed skin on top, fine matte wood-fiber core inside cuts
    let speck_a = sin(wp.x * 19.3 + wp.y * 23.7 + wp.z * 17.1);
    let speck_b = cos(wp.x * 41.2 - wp.y * 37.9 + wp.z * 29.4);
    let fiber_noise = 0.5 + 0.25 * speck_a + 0.25 * speck_b;
    // Slight core density gradient across board thickness
    let core_base = mix(vec3<f32>(0.73, 0.59, 0.41), vec3<f32>(0.79, 0.66, 0.47), fiber_noise);
    let top_skin  = mix(vec3<f32>(0.80, 0.68, 0.50), vec3<f32>(0.83, 0.71, 0.53), fiber_noise * 0.5);
    return select(core_base, top_skin, is_uncut_top);
}

fn birch_plywood_albedo(wp: vec3<f32>, top_z: f32) -> vec3<f32> {
    // Multi-layer Baltic Birch Plywood (桦木多层板): 1.45 mm cross-banded light/warm birch veneers + dark phenolic glue lines
    let depth = max(top_z - wp.z, 0.0);
    let ply_pitch = 1.45;
    let ply_coord = depth / ply_pitch;
    let ply_idx = i32(floor(ply_coord));
    let ply_frac = fract(ply_coord);

    // Alternating 90-degree cross-grained birch plies
    let grain_along = select(
        sin(wp.y * 0.22 + sin(wp.x * 0.08) * 1.6),
        sin(wp.x * 0.22 + sin(wp.y * 0.08) * 1.6),
        (ply_idx & 1) == 0
    );
    let birch_face = mix(vec3<f32>(0.93, 0.85, 0.69), vec3<f32>(0.87, 0.76, 0.57), 0.5 + 0.5 * grain_along);
    let birch_cross = mix(vec3<f32>(0.79, 0.65, 0.46), vec3<f32>(0.72, 0.57, 0.39), 0.5 + 0.5 * grain_along);
    let veneer_col = select(birch_cross, birch_face, (ply_idx & 1) == 0);

    // Crisp dark resin glue line at every veneer boundary (except the very top uncut face)
    let glue_dist = min(ply_frac, 1.0 - ply_frac);
    let is_glue = smoothstep(0.09, 0.015, glue_dist) * select(1.0, 0.0, depth < 0.08);
    let glue_col = vec3<f32>(0.45, 0.32, 0.19);
    return mix(veneer_col, glue_col, is_glue * 0.82);
}

fn depth_heatmap_albedo(t_raw: f32) -> vec3<f32> {
    // Perceptual CAD Depth Elevation Ramp (0.0 Top = Slate/Blue -> Cyan -> Green -> Yellow -> Red = Deepest)
    let t = clamp(t_raw, 0.0, 1.0);
    let c0 = vec3<f32>(0.18, 0.34, 0.82);
    let c1 = vec3<f32>(0.06, 0.72, 0.86);
    let c2 = vec3<f32>(0.16, 0.80, 0.44);
    let c3 = vec3<f32>(0.96, 0.82, 0.18);
    let c4 = vec3<f32>(0.92, 0.24, 0.18);
    if (t < 0.25) {
        return mix(c0, c1, t / 0.25);
    } else if (t < 0.50) {
        return mix(c1, c2, (t - 0.25) / 0.25);
    } else if (t < 0.75) {
        return mix(c2, c3, (t - 0.50) / 0.25);
    }
    return mix(c3, c4, (t - 0.75) / 0.25);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    // Compute all screen-space derivatives in uniform control flow (WGSL strict uniformity rule)
    let fwx = max(fwidth(in.world_pos.x / 10.0), 1e-5);
    let fwy = max(fwidth(in.world_pos.y / 10.0), 1e-5);

    let coarse_step = max(round(u.grid_info.x / 72.0), 1.0);
    let uv_c = in.grid_uv / coarse_step;
    let fwc_u = max(fwidth(uv_c.x), 1e-5);
    let fwc_v = max(fwidth(uv_c.y), 1e-5);
    let fwc_d = max(fwidth(uv_c.x - uv_c.y), 1e-5);

    let fwf_u = max(fwidth(in.grid_uv.x), 1e-5);
    let fwf_v = max(fwidth(in.grid_uv.y), 1e-5);
    let fwf_d = max(fwidth(in.grid_uv.x - in.grid_uv.y), 1e-5);

    let wall_pitch = max(coarse_step * u.grid_info.z, 0.5);
    let wp_s = in.world_pos / wall_pitch;
    let fww_x = max(fwidth(wp_s.x), 1e-5);
    let fww_y = max(fwidth(wp_s.y), 1e-5);
    let fww_z = max(fwidth(wp_s.z), 1e-5);

    let is_light = u.stock_min.w > 0.5;
    let wire_mode = u32(round(u.style_info.w));
    let fw_z_mm = max(fwidth(in.world_pos.z), 1e-5);
    let hatch_coord = (in.world_pos.x + in.world_pos.y + in.world_pos.z) * 0.85;
    let fw_hatch = max(fwidth(hatch_coord), 1e-5);

    // Floor plane pass (adapts to Dark & Light theme via u.stock_min.w)
    if (in.part_zone == 4u) {
        let gx = abs(fract(in.world_pos.x / 10.0 - 0.5) - 0.5) / fwx;
        let gy = abs(fract(in.world_pos.y / 10.0 - 0.5) - 0.5) / fwy;
        let line_alpha = 1.0 - clamp(min(gx, gy), 0.0, 1.0);
        let dist_fade = 1.0 - smoothstep(0.32, 0.98, length(in.grid_uv));
        let base_floor = select(vec3<f32>(0.045, 0.045, 0.055), vec3<f32>(0.945, 0.948, 0.958), is_light);
        let grid_line  = select(vec3<f32>(0.19, 0.20, 0.23), vec3<f32>(0.76, 0.78, 0.82), is_light);
        let col = mix(base_floor, grid_line, line_alpha * 0.72);
        return vec4<f32>(col, dist_fade * 0.75);
    }

    // Dynamic 3D Cross-Section Clipping (on Top, Skirt, Bottom)
    let sec_axis = u32(round(u.section_info.x));
    if (in.part_zone <= 1u) {
        if (sec_axis == 1u && in.world_pos.x < u.section_info.y - 1e-4) {
            discard;
        }
        if (sec_axis == 2u && in.world_pos.y < u.section_info.y - 1e-4) {
            discard;
        }
    }

    // Open real see-through holes when cutter pierces below stock_min.z!
    if ((in.part_zone == 0u || in.part_zone == 1u || in.part_zone == 5u) && in.raw_z < u.stock_min.z - 0.03) {
        discard;
    }

    var N = normalize(in.normal);
    let V = normalize(u.camera_pos.xyz - in.world_pos);

    // 3-Point Studio CAD Lighting Rig (Key + Cool Rim + Warm Fill + Sky/Ground Hemisphere)
    let L_key  = normalize(vec3<f32>(-0.48, -0.58, 0.66));
    let L_fill = normalize(vec3<f32>( 0.68, -0.25, 0.68));
    let L_rim  = normalize(vec3<f32>( 0.15,  0.82, 0.55));

    let mat_id = u32(round(u.style_info.x));
    var albedo = vec3<f32>(0.76, 0.79, 0.83);
    var metallic = 0.78;
    var roughness = 0.28;

    if (in.part_zone == 2u) {
        // Cutter Flute: Bright Ground Tungsten-Carbide Silver Metal with 4 helical flutes
        let helix = in.grid_uv.x * 4.0 - in.grid_uv.y * 18.0;
        let flute_crest = 0.5 + 0.5 * cos(helix);
        let tang_u = vec3<f32>(-sin(in.grid_uv.x), cos(in.grid_uv.x), 0.0);
        N = normalize(N + tang_u * sin(helix) * 0.34 + vec3<f32>(0.0, 0.0, 0.16));
        albedo = mix(vec3<f32>(0.68, 0.73, 0.80), vec3<f32>(0.95, 0.97, 1.0), flute_crest);
        metallic = 0.72;
        roughness = 0.20;
    } else if (in.part_zone == 3u) {
        // Cutter Shank & Collet: Precision Ground Chrome-Steel Shank + Satin Steel Collet
        let is_collet = in.grid_uv.y > 0.84;
        N = normalize(N + vec3<f32>(0.0, 0.0, 0.14));
        albedo = select(vec3<f32>(0.88, 0.91, 0.95), vec3<f32>(0.70, 0.74, 0.80), is_collet);
        metallic = 0.70;
        roughness = select(0.18, 0.28, is_collet);
    } else {
        switch (mat_id) {
            case 0u: {
                // 6061 Brushed / Milled Aerospace Aluminum
                let is_uncut_top = in.part_zone == 0u && in.raw_z >= u.stock_max.z - 0.002;
                albedo = select(vec3<f32>(0.79, 0.83, 0.88), vec3<f32>(0.66, 0.70, 0.76), is_uncut_top);
                metallic = 0.82;
                roughness = select(0.24, 0.36, is_uncut_top);
            }
            case 1u: {
                // Carved Rosewood / Warm Beechwood
                albedo = wood_grain_albedo(in.world_pos);
                metallic = 0.06;
                roughness = 0.46;
            }
            case 2u: {
                // Precision H62 Brass
                let is_uncut_top = in.part_zone == 0u && in.raw_z >= u.stock_max.z - 0.002;
                albedo = select(vec3<f32>(0.91, 0.74, 0.36), vec3<f32>(0.75, 0.60, 0.29), is_uncut_top);
                metallic = 0.86;
                roughness = 0.23;
            }
            case 4u: {
                // Natural Pine Wood (松木)
                albedo = pine_wood_albedo(in.world_pos);
                metallic = 0.03;
                roughness = 0.54;
            }
            case 5u: {
                // Z-Depth Elevation Heatmap + 1mm contour lines
                let z_span = max(u.stock_max.z - u.stock_min.z, 0.1);
                let depth_t = clamp((u.stock_max.z - in.world_pos.z) / z_span, 0.0, 1.0);
                let base_heat = depth_heatmap_albedo(depth_t);
                let iso_dist = abs(fract(in.world_pos.z - 0.5) - 0.5) / fw_z_mm;
                let iso_line = (1.0 - smoothstep(0.0, 1.2, iso_dist)) * select(0.28, 0.0, N.z > 0.98);
                albedo = mix(base_heat, base_heat * 0.55, iso_line);
                metallic = 0.08;
                roughness = 0.42;
            }
            case 6u: {
                // Medium-Density Fiberboard (密度板 MDF)
                let is_uncut_top = in.part_zone == 0u && in.raw_z >= u.stock_max.z - 0.002;
                albedo = mdf_board_albedo(in.world_pos, is_uncut_top);
                metallic = 0.02;
                roughness = select(0.68, 0.52, is_uncut_top);
            }
            case 7u: {
                // Birch Multi-Layer Plywood (桦木多层板)
                albedo = birch_plywood_albedo(in.world_pos, u.stock_max.z);
                metallic = 0.03;
                roughness = 0.50;
            }
            default: {
                // Celadon Jade / Sculpting Polymer
                albedo = vec3<f32>(0.48, 0.76, 0.66);
                metallic = 0.05;
                roughness = 0.26;
            }
        }

        // Subtle CAD engineering 45° section hatch on the cut cross-section plane!
        if (in.part_zone == 5u) {
            let hd = abs(fract(hatch_coord - 0.5) - 0.5) / fw_hatch;
            let hline = 1.0 - smoothstep(0.0, 1.2, hd);
            albedo = mix(albedo * 0.94, albedo * 0.68, hline * 0.55);
            metallic = metallic * 0.35;
            roughness = max(roughness, 0.48);
        }
    }

    let ao = select(1.0, compute_heightfield_ao(in.grid_uv, in.world_pos.z), in.part_zone == 0u);

    // Cook-Torrance / Blinn-Phong Studio Shading
    let ndl_key  = max(dot(N, L_key), 0.0);
    let ndl_fill = max(dot(N, L_fill), 0.0);
    let ndl_rim  = max(dot(N, L_rim), 0.0);

    let H_key  = normalize(L_key + V);
    let H_fill = normalize(L_fill + V);
    let H_rim  = normalize(L_rim + V);

    let shininess = mix(190.0, 14.0, roughness);
    let f0 = mix(vec3<f32>(0.04), albedo, metallic);
    let fresnel = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - max(dot(N, V), 0.0), 5.0);

    let spec_norm = (shininess + 8.0) / 25.1327;
    let spec_key  = pow(max(dot(N, H_key), 0.0), shininess) * spec_norm * ndl_key;
    let spec_fill = pow(max(dot(N, H_fill), 0.0), shininess * 0.7) * spec_norm * 0.45 * ndl_fill;
    let spec_rim  = pow(max(dot(N, H_rim), 0.0), shininess * 0.8) * spec_norm * 0.55 * ndl_rim;

    let kd = (vec3<f32>(1.0) - fresnel) * (1.0 - metallic * 0.72);
    let hemi = mix(vec3<f32>(0.16, 0.18, 0.22), vec3<f32>(0.46, 0.50, 0.58), N.z * 0.5 + 0.5);

    var color = kd * albedo * (hemi * 0.75 + ndl_key * vec3<f32>(1.05, 1.02, 0.98) + ndl_fill * vec3<f32>(0.45, 0.52, 0.62) + ndl_rim * vec3<f32>(0.32, 0.36, 0.42));
    color = color + fresnel * (spec_key * vec3<f32>(1.05, 1.02, 0.98) + spec_fill * vec3<f32>(0.65, 0.75, 0.92) + spec_rim * vec3<f32>(0.55, 0.65, 0.80));

    // 360-degree Studio Softbox Environment Reflection (illuminates vertical cylindrical tools & 90° milled walls!)
    let R = reflect(-V, N);
    let sky_band = smoothstep(-0.35, 0.65, R.z) * (0.65 + 0.35 * sin(R.x * 3.0 + R.y * 2.0));
    let horiz = 1.0 - abs(R.z) * 0.55;
    let strip_a = pow(max(dot(normalize(vec2<f32>(R.x, R.y) + vec2<f32>(1e-5)), vec2<f32>(-0.6, -0.8)), 0.0), 4.0);
    let strip_b = pow(max(dot(normalize(vec2<f32>(R.x, R.y) + vec2<f32>(1e-5)), vec2<f32>( 0.85, 0.52)), 0.0), 6.0);
    let studio_env = sky_band * 0.32 + horiz * (0.22 + strip_a * 0.55 + strip_b * 0.38);
    color = color + f0 * metallic * studio_env;

    // Subtle Jade subsurface translucency boost on thin crests
    if (mat_id == 3u && in.part_zone == 0u) {
        let sss = pow(clamp(1.0 - ao + 0.35, 0.0, 1.0), 1.5) * 0.18;
        color = color + vec3<f32>(0.22, 0.55, 0.42) * sss;
    }

    color = color * ao;

    // ACES-inspired filmic tone mapping
    var final_rgb = clamp(
        (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14),
        vec3<f32>(0.0),
        vec3<f32>(1.0)
    );

    // Anti-aliased Adaptive 3D Mesh Wireframe (Shaded+Wireframe & Hidden-Line Pure CAD Wireframe)
    if (wire_mode > 0u && (in.part_zone == 0u || in.part_zone == 1u)) {
        var wire_alpha: f32 = 0.0;
        if (in.part_zone == 0u) {
            let dc_u = abs(fract(uv_c.x - 0.5) - 0.5) / fwc_u;
            let dc_v = abs(fract(uv_c.y - 0.5) - 0.5) / fwc_v;
            let dc_d = abs(fract((uv_c.x - uv_c.y) - 0.5) - 0.5) / fwc_d;
            let coarse_line = 1.0 - smoothstep(0.0, 1.15, min(min(dc_u, dc_v), dc_d * 1.15));

            // Fade in fine 1x1 true simulation triangles when zoomed close
            let fine_vis = 1.0 - smoothstep(0.14, 0.30, max(fwf_u, fwf_v));
            var fine_line: f32 = 0.0;
            if (fine_vis > 0.01) {
                let df_u = abs(fract(in.grid_uv.x - 0.5) - 0.5) / fwf_u;
                let df_v = abs(fract(in.grid_uv.y - 0.5) - 0.5) / fwf_v;
                let df_d = abs(fract((in.grid_uv.x - in.grid_uv.y) - 0.5) - 0.5) / fwf_d;
                fine_line = (1.0 - smoothstep(0.0, 1.1, min(min(df_u, df_v), df_d))) * fine_vis * 0.55;
            }
            wire_alpha = max(coarse_line, fine_line);
        } else {
            let dw_x = abs(fract(wp_s.x - 0.5) - 0.5) / fww_x;
            let dw_y = abs(fract(wp_s.y - 0.5) - 0.5) / fww_y;
            let dw_z = abs(fract(wp_s.z - 0.5) - 0.5) / fww_z;
            let best_w = select(min(dw_x, dw_z), min(dw_y, dw_z), abs(N.x) > 0.5);
            wire_alpha = 1.0 - smoothstep(0.0, 1.15, best_w);
        }

        if (wire_mode == 2u) {
            // Pure Hidden-Line CAD Wireframe: clean solid silhouette occlusion + slope/AO-accented technical ink lines
            let bg_fill = select(vec3<f32>(0.065, 0.068, 0.082), vec3<f32>(0.975, 0.978, 0.985), is_light);
            let ink_col = select(
                mix(vec3<f32>(0.38, 0.72, 0.96), vec3<f32>(0.88, 0.92, 0.98), N.z * 0.5 + 0.5),
                mix(vec3<f32>(0.08, 0.10, 0.14), vec3<f32>(0.24, 0.27, 0.34), N.z * 0.5 + 0.5),
                is_light
            );
            let cavity_tint = mix(bg_fill * 0.90, bg_fill, ao);
            final_rgb = mix(cavity_tint, ink_col, clamp(wire_alpha * 0.95, 0.0, 1.0));
        } else {
            // Shaded + Wireframe overlay
            let overlay_col = select(vec3<f32>(0.08, 0.10, 0.14), vec3<f32>(0.12, 0.14, 0.18), is_light);
            final_rgb = mix(final_rgb, overlay_col, wire_alpha * 0.42);
        }
    }

    return vec4<f32>(final_rgb, 1.0);
}
