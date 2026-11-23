// Toolpath Wireframe & Material Bounding Box Shader (WGSL)
// Supports high-contrast palettes in both Light Mode & Dark Mode, plus 12-edge stock outline.

struct LineUniforms {
    view_proj: mat4x4<f32>,
    // x = show_rapids (0/1), y = show_cuts (0/1), z = is_light_theme (0/1), w = pass_mode (0=segments, 1=stock_box, 2=wcs_triad)
    opts: vec4<f32>,
    stock_min: vec4<f32>,
    stock_max: vec4<f32>,
    wcs_origin: vec4<f32>,
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

@group(0) @binding(0) var<uniform> u: LineUniforms;
@group(0) @binding(1) var<storage, read> segments: array<GpuSegment>;

struct VsOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) color: vec4<f32>,
};

fn stock_corner(idx: u32) -> vec3<f32> {
    let x = select(u.stock_min.x, u.stock_max.x, (idx & 1u) != 0u);
    let y = select(u.stock_min.y, u.stock_max.y, (idx & 2u) != 0u);
    let z = select(u.stock_min.z, u.stock_max.z, (idx & 4u) != 0u);
    return vec3<f32>(x, y, z);
}

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
    var out: VsOut;
    let is_light = u.opts.z > 0.5;

    // Pass mode 2: 3D WCS Zero Origin Triad at u.wcs_origin.xyz (6 vertices = X Red, Y Green, Z Blue)
    if (u.opts.w > 1.5) {
        let span = max(u.stock_max.x - u.stock_min.x, u.stock_max.y - u.stock_min.y);
        let axis_len = clamp(span * 0.22, 10.0, 38.0);
        let axis_id = (vid / 2u) % 3u;
        let is_tip = (vid % 2u) == 1u;
        var wp = u.wcs_origin.xyz + vec3<f32>(0.0, 0.0, 0.08);
        var col = vec4<f32>(0.94, 0.26, 0.26, 0.95);
        if (axis_id == 0u) {
            if (is_tip) { wp.x = wp.x + axis_len; }
            col = vec4<f32>(0.94, 0.26, 0.26, 0.95); // +X Red
        } else if (axis_id == 1u) {
            if (is_tip) { wp.y = wp.y + axis_len; }
            col = vec4<f32>(0.13, 0.76, 0.42, 0.95); // +Y Green
        } else {
            if (is_tip) { wp.z = wp.z + axis_len; }
            col = vec4<f32>(0.23, 0.52, 0.96, 0.95); // +Z Blue
        }
        out.clip_pos = u.view_proj * vec4<f32>(wp, 1.0);
        out.color = col;
        return out;
    }

    // Pass mode 1: 12-edge 3D Stock Bounding Box (24 vertices)
    if (u.opts.w > 0.5) {
        let edges = array<u32, 24>(
            0u, 1u,  1u, 3u,  3u, 2u,  2u, 0u, // bottom face
            4u, 5u,  5u, 7u,  7u, 6u,  6u, 4u, // top face
            0u, 4u,  1u, 5u,  2u, 6u,  3u, 7u  // 4 vertical pillars
        );
        let c_idx = edges[vid % 24u];
        let wp = stock_corner(c_idx);
        out.clip_pos = u.view_proj * vec4<f32>(wp, 1.0);
        out.color = select(
            vec4<f32>(0.55, 0.58, 0.66, 0.52),
            vec4<f32>(0.38, 0.42, 0.48, 0.58),
            is_light
        );
        return out;
    }

    let seg_idx = vid / 2u;
    let end_idx = vid % 2u;
    let seg = segments[seg_idx];
    let is_cut = (seg.kind_and_tool & 255u) != 0u;

    if ((!is_cut && u.opts.x < 0.5) || (is_cut && u.opts.y < 0.5)) {
        out.clip_pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
        out.color = vec4<f32>(0.0);
        return out;
    }

    let p = select(
        vec3<f32>(seg.x0, seg.y0, seg.z0 + 0.06),
        vec3<f32>(seg.x1, seg.y1, seg.z1 + 0.06),
        end_idx == 1u
    );
    out.clip_pos = u.view_proj * vec4<f32>(p, 1.0);

    if (!is_cut) {
        // G0 Rapid Traverse: High-visibility Coral Red / Orange
        out.color = select(
            vec4<f32>(1.0, 0.38, 0.30, 0.82),
            vec4<f32>(0.88, 0.22, 0.18, 0.80),
            is_light
        );
    } else {
        // G1/G2/G3 Cutting Moves: Crisp Depth/Feed-accented Blue -> Teal
        let z_span = max(u.stock_max.z - u.stock_min.z, 1.0);
        let depth_t = clamp((u.stock_max.z - p.z) / z_span, 0.0, 1.0);
        if (is_light) {
            let col_top = vec3<f32>(0.03, 0.45, 0.85);
            let col_bot = vec3<f32>(0.05, 0.62, 0.48);
            out.color = vec4<f32>(mix(col_top, col_bot, depth_t), 0.90);
        } else {
            let col_top = vec3<f32>(0.24, 0.76, 0.98);
            let col_bot = vec3<f32>(0.20, 0.90, 0.66);
            out.color = vec4<f32>(mix(col_top, col_bot, depth_t), 0.88);
        }
    }
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    if (in.color.a <= 0.01) {
        discard;
    }
    return in.color;
}
