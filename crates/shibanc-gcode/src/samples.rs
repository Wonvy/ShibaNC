//! Built-in parametric CNC G-code generators for realistic `.tap` (3D relief carving)
//! and `.nc` (precision 3-axis milled mechanical housing) sample files.

use std::fmt::Write;

/// Generate a realistic 3D relief carving `.tap` file (Mandala / Lotus Medallion Relief, ~45,000 moves).
pub fn generate_relief_tap_sample() -> String {
    let mut out = String::with_capacity(1_400_000);
    let _ = writeln!(out, "(ShibaNC Sample Relief Carving - Lotus Medallion.tap)");
    let _ = writeln!(out, "(STOCK/BLOCK, 84, 84, 14, 42, 42, 14)");
    let _ = writeln!(out, "(T1 D=3.175 CR=0.4 TAPER=3.5deg - tapered ball end mill)");
    let _ = writeln!(out, "G90 G21 G17");
    let _ = writeln!(out, "T1 M6");
    let _ = writeln!(out, "S18000 M3");
    let _ = writeln!(out, "G0 Z8.000");

    let half = 38.0f64;
    let step_y = 0.42f64;
    let step_x = 0.35f64;
    let rows = ((half * 2.0) / step_y).round() as usize;
    let cols = ((half * 2.0) / step_x).round() as usize;

    // Zig-zag raster finishing pass over 3D lotus medallion relief
    let mut first = true;
    for r in 0..=rows {
        let y = -half + (r as f64) * step_y;
        let forward = r % 2 == 0;
        for c in 0..=cols {
            let ci = if forward { c } else { cols - c };
            let x = -half + (ci as f64) * step_x;
            let z = relief_height(x, y);

            if first {
                let _ = writeln!(out, "G0 X{:.3} Y{:.3}", x, y);
                let _ = writeln!(out, "G1 Z{:.3} F800", z);
                let _ = writeln!(out, "F3200");
                first = false;
            } else {
                let _ = writeln!(out, "G1 X{:.3} Y{:.3} Z{:.3}", x, y, z);
            }
        }
    }

    // Circular outer frame groove
    let frame_r = 36.8f64;
    let _ = writeln!(out, "G0 Z5.000");
    let _ = writeln!(out, "G0 X{:.3} Y0.000", frame_r);
    let _ = writeln!(out, "G1 Z-7.800 F600");
    let _ = writeln!(out, "G2 X{:.3} Y0.000 I{:.3} J0.000 F2200", -frame_r, -frame_r);
    let _ = writeln!(out, "G2 X{:.3} Y0.000 I{:.3} J0.000", frame_r, frame_r);
    let _ = writeln!(out, "G0 Z10.000");
    let _ = writeln!(out, "M5");
    let _ = writeln!(out, "M30");
    out
}

fn relief_height(x: f64, y: f64) -> f64 {
    let r = (x * x + y * y).sqrt();
    if r > 36.8 {
        return -0.2; // Uncut rim top border
    }
    let theta = y.atan2(x);
    // Sunken dish base (-8.2mm at rim, curving up gently)
    let dish = -8.2 + 1.4 * (1.0 - (r / 36.8).powi(2));

    // 8-petal layered lotus relief + inner 16-petal rosette + central dome + beaded ring
    let petal8 = (8.0 * theta).cos();
    let petal8_env = (-((r - 22.0) / 8.5).powi(2)).exp() * (2.6 + 2.1 * petal8);

    let petal16 = (16.0 * theta + 0.2).cos();
    let petal16_env = (-((r - 12.5) / 5.2).powi(2)).exp() * (2.2 + 1.4 * petal16);

    let center_dome = (-(r / 6.2).powi(2)).exp() * 5.2;

    // Decorative beaded ring near r = 32.5mm
    let bead_angle = 36.0 * theta;
    let beads = (-((r - 32.5) / 1.6).powi(2)).exp() * (1.3 + 0.9 * bead_angle.cos());

    // Spiral wave ripple detail
    let ripple = 0.22 * (r * 1.35 - 4.0 * theta).sin() * (1.0 - (r / 37.0).clamp(0.0, 1.0));

    (dish + petal8_env.max(petal16_env).max(center_dome) + beads + ripple).clamp(-8.8, -0.15)
}

/// Generate a realistic 3-axis mechanical precision milled housing `.nc` file (with G2/G3 arcs & G81 drilled holes).
pub fn generate_mechanical_nc_sample() -> String {
    let mut out = String::with_capacity(250_000);
    let _ = writeln!(out, "%");
    let _ = writeln!(out, "O1001 (SHIBANC PRECISION AEROSPACE BRACKET HOUSING)");
    let _ = writeln!(out, "(STOCK/BLOCK, 110, 80, 22, 55, 40, 22)");
    let _ = writeln!(out, "(T1 D=6.0 CR=0.0 - flat end mill)");
    let _ = writeln!(out, "G90 G21 G17 G40 G80");
    let _ = writeln!(out, "T1 M6");
    let _ = writeln!(out, "S10000 M3");
    let _ = writeln!(out, "G0 Z10.000");

    // 1. Outer rounded-rectangle step shoulder milling (2 depth passes: Z=-4, Z=-8)
    for &z_dep in &[-4.0f64, -8.0] {
        // Clear outer perimeter ledge leaving 92x62 rounded boss (corner R10)
        for &offset in &[8.5f64, 5.8, 3.0] {
            let hx = 36.0 + offset;
            let hy = 21.0 + offset;
            let cr = 10.0 + offset;
            let _ = writeln!(out, "G0 X{:.3} Y{:.3}", -hx + cr, -hy);
            let _ = writeln!(out, "G1 Z{:.3} F500", z_dep);
            let _ = writeln!(out, "G1 X{:.3} Y{:.3} F2000", hx - cr, -hy);
            let _ = writeln!(out, "G3 X{:.3} Y{:.3} I0.000 J{:.3}", hx, -hy + cr, cr);
            let _ = writeln!(out, "G1 X{:.3} Y{:.3}", hx, hy - cr);
            let _ = writeln!(out, "G3 X{:.3} Y{:.3} I{:.3} J0.000", hx - cr, hy, -cr);
            let _ = writeln!(out, "G1 X{:.3} Y{:.3}", -hx + cr, hy);
            let _ = writeln!(out, "G3 X{:.3} Y{:.3} I0.000 J{:.3}", -hx, hy - cr, -cr);
            let _ = writeln!(out, "G1 X{:.3} Y{:.3}", -hx, -hy + cr);
            let _ = writeln!(out, "G3 X{:.3} Y{:.3} I{:.3} J0.000", -hx + cr, -hy, cr);
        }
        let _ = writeln!(out, "G0 Z5.000");
    }

    // 2. Central circular bearing bore + inner counterbore (spiral/concentric G2/G3 pocketing)
    // Counterbore R20 to Z=-6.0, Inner bore R11 to Z=-16.0
    for &(max_r, target_z) in &[(17.0f64, -6.0f64), (8.0f64, -16.0f64)] {
        let mut z = -3.0f64;
        while z >= target_z - 0.01 {
            let zc = z.max(target_z);
            let _ = writeln!(out, "G0 X0.000 Y0.000");
            let _ = writeln!(out, "G1 Z{:.3} F400", zc);
            let mut r = 2.2f64;
            while r <= max_r + 0.01 {
                let rc = r.min(max_r);
                let _ = writeln!(out, "G1 X{:.3} Y0.000 F1800", rc);
                let _ = writeln!(out, "G3 X{:.3} Y0.000 I{:.3} J0.000", -rc, -rc);
                let _ = writeln!(out, "G3 X{:.3} Y0.000 I{:.3} J0.000", rc, rc);
                if (rc - max_r).abs() < 1e-4 {
                    break;
                }
                r += 2.4;
            }
            let _ = writeln!(out, "G0 Z4.000");
            if (zc - target_z).abs() < 1e-4 {
                break;
            }
            z -= 3.5;
        }
    }

    // 3. Two symmetric lightening pockets on left/right wings of boss
    for &cx in &[-27.0f64, 27.0f64] {
        let _ = writeln!(out, "G0 X{:.3} Y0.000", cx + 3.5);
        let _ = writeln!(out, "G1 Z-5.500 F450");
        let _ = writeln!(out, "G3 X{:.3} Y0.000 I-3.500 J0.000 F1600", cx - 3.5);
        let _ = writeln!(out, "G3 X{:.3} Y0.000 I3.500 J0.000", cx + 3.5);
        let _ = writeln!(out, "G1 X{:.3} Y0.000", cx + 1.5);
        let _ = writeln!(out, "G3 X{:.3} Y0.000 I-1.500 J0.000", cx - 1.5);
        let _ = writeln!(out, "G3 X{:.3} Y0.000 I1.500 J0.000", cx + 1.5);
        let _ = writeln!(out, "G0 Z5.000");
    }

    // 4. Four corner through-holes on outer mounting flange using modal G81 Canned Drilling Cycle
    let hole_coords = [
        (-42.0, -26.0),
        (42.0, -26.0),
        (42.0, 26.0),
        (-42.0, 26.0),
    ];
    let _ = writeln!(out, "G0 Z8.000");
    for (i, &(hx, hy)) in hole_coords.iter().enumerate() {
        if i == 0 {
            let _ = writeln!(out, "G81 X{:.3} Y{:.3} Z-23.000 R2.000 F450", hx, hy);
        } else {
            let _ = writeln!(out, "X{:.3} Y{:.3}", hx, hy);
        }
    }
    let _ = writeln!(out, "G80");
    let _ = writeln!(out, "G0 Z15.000");
    let _ = writeln!(out, "M5");
    let _ = writeln!(out, "M30");
    let _ = writeln!(out, "%");
    out
}
