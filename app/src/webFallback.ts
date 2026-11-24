// Browser-mode runtime bridge when viewing ShibaNC directly in a Web Browser (outside Tauri shell).
// Imports the exact shared WGSL shaders via Vite `?raw` and provides fast client-side G-code parsing & samples.

import simWgsl from "../../shaders/sim_3axis.wgsl?raw";
import studioPartWgsl from "../../shaders/studio_part.wgsl?raw";
import toolpathWgsl from "../../shaders/toolpath.wgsl?raw";
import { ProgramPayloadDto, ShadersDto, StockSpec, ToolSpec } from "./types";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function getWebShaders(): ShadersDto {
  return {
    sim_wgsl: simWgsl,
    studio_part_wgsl: studioPartWgsl,
    toolpath_wgsl: toolpathWgsl,
  };
}

export interface ParsedWebGcode {
  dto: ProgramPayloadDto;
  segmentsBuffer: ArrayBuffer;
}

export function generateWebSampleText(kind: "relief_tap" | "mechanical_nc"): {
  text: string;
  name: string;
  ext: string;
} {
  if (kind === "mechanical_nc") {
    const lines: string[] = [
      "%",
      "O1001 (SHIBANC PRECISION AEROSPACE BRACKET HOUSING)",
      "(STOCK/BLOCK, 110, 80, 22, 55, 40, 22)",
      "(T1 D=6.0 CR=0.0 - flat end mill)",
      "G90 G21 G17 G40 G80",
      "T1 M6",
      "S10000 M3",
      "G0 Z10.000",
    ];
    for (const zDep of [-4.0, -8.0]) {
      for (const offset of [8.5, 5.8, 3.0]) {
        const hx = 36 + offset;
        const hy = 21 + offset;
        const cr = 10 + offset;
        lines.push(`G0 X${(-hx + cr).toFixed(3)} Y${(-hy).toFixed(3)}`);
        lines.push(`G1 Z${zDep.toFixed(3)} F500`);
        lines.push(`G1 X${(hx - cr).toFixed(3)} Y${(-hy).toFixed(3)} F2000`);
        lines.push(`G3 X${hx.toFixed(3)} Y${(-hy + cr).toFixed(3)} I0.000 J${cr.toFixed(3)}`);
        lines.push(`G1 X${hx.toFixed(3)} Y${(hy - cr).toFixed(3)}`);
        lines.push(`G3 X${(hx - cr).toFixed(3)} Y${hy.toFixed(3)} I${(-cr).toFixed(3)} J0.000`);
        lines.push(`G1 X${(-hx + cr).toFixed(3)} Y${hy.toFixed(3)}`);
        lines.push(`G3 X${(-hx).toFixed(3)} Y${(hy - cr).toFixed(3)} I0.000 J${(-cr).toFixed(3)}`);
        lines.push(`G1 X${(-hx).toFixed(3)} Y${(-hy + cr).toFixed(3)}`);
        lines.push(`G3 X${(-hx + cr).toFixed(3)} Y${(-hy).toFixed(3)} I${cr.toFixed(3)} J0.000`);
      }
      lines.push("G0 Z5.000");
    }
    for (const [maxR, targetZ] of [
      [17.0, -6.0],
      [8.0, -16.0],
    ] as const) {
      for (let z = -3.0; z >= targetZ - 0.01; z = Math.max(z - 3.5, targetZ - 0.001)) {
        const zc = Math.max(z, targetZ);
        lines.push("G0 X0.000 Y0.000");
        lines.push(`G1 Z${zc.toFixed(3)} F400`);
        for (let r = 2.2; r <= maxR + 0.01; r += 2.4) {
          const rc = Math.min(r, maxR);
          lines.push(`G1 X${rc.toFixed(3)} Y0.000 F1800`);
          lines.push(`G3 X${(-rc).toFixed(3)} Y0.000 I${(-rc).toFixed(3)} J0.000`);
          lines.push(`G3 X${rc.toFixed(3)} Y0.000 I${rc.toFixed(3)} J0.000`);
          if (Math.abs(rc - maxR) < 1e-4) break;
        }
        lines.push("G0 Z4.000");
        if (Math.abs(zc - targetZ) < 1e-4) break;
      }
    }
    for (const cx of [-27.0, 27.0]) {
      lines.push(`G0 X${(cx + 3.5).toFixed(3)} Y0.000`);
      lines.push("G1 Z-5.500 F450");
      lines.push(`G3 X${(cx - 3.5).toFixed(3)} Y0.000 I-3.500 J0.000 F1600`);
      lines.push(`G3 X${(cx + 3.5).toFixed(3)} Y0.000 I3.500 J0.000`);
      lines.push(`G1 X${(cx + 1.5).toFixed(3)} Y0.000`);
      lines.push(`G3 X${(cx - 1.5).toFixed(3)} Y0.000 I-1.500 J0.000`);
      lines.push(`G3 X${(cx + 1.5).toFixed(3)} Y0.000 I1.500 J0.000`);
      lines.push("G0 Z5.000");
    }
    lines.push("G0 Z8.000");
    lines.push("G81 X-42.000 Y-26.000 Z-23.000 R2.000 F450");
    lines.push("X42.000 Y-26.000");
    lines.push("X42.000 Y26.000");
    lines.push("X-42.000 Y26.000");
    lines.push("G80");
    lines.push("G0 Z15.000");
    lines.push("M5");
    lines.push("M30");
    return {
      text: lines.join("\n"),
      name: "aerospace_bearing_housing.nc",
      ext: "nc",
    };
  }

  // Relief .tap Lotus Medallion
  const lines: string[] = [
    "(ShibaNC Sample Relief Carving - Lotus Medallion.tap)",
    "(STOCK/BLOCK, 84, 84, 14, 42, 42, 14)",
    "(T1 D=3.175 CR=0.4 TAPER=3.5deg - tapered ball end mill)",
    "G90 G21 G17",
    "T1 M6",
    "S18000 M3",
    "G0 Z8.000",
  ];
  const half = 38.0;
  const stepY = 0.48;
  const stepX = 0.42;
  const rows = Math.round((half * 2) / stepY);
  const cols = Math.round((half * 2) / stepX);
  let first = true;
  for (let r = 0; r <= rows; r++) {
    const y = -half + r * stepY;
    const forward = r % 2 === 0;
    for (let c = 0; c <= cols; c++) {
      const ci = forward ? c : cols - c;
      const x = -half + ci * stepX;
      const rad = Math.hypot(x, y);
      let z = -0.2;
      if (rad <= 36.8) {
        const theta = Math.atan2(y, x);
        const dish = -8.2 + 1.4 * (1 - (rad / 36.8) ** 2);
        const p8 = Math.exp(-(((rad - 22.0) / 8.5) ** 2)) * (2.6 + 2.1 * Math.cos(8 * theta));
        const p16 =
          Math.exp(-(((rad - 12.5) / 5.2) ** 2)) * (2.2 + 1.4 * Math.cos(16 * theta + 0.2));
        const dome = Math.exp(-((rad / 6.2) ** 2)) * 5.2;
        const beads =
          Math.exp(-(((rad - 32.5) / 1.6) ** 2)) * (1.3 + 0.9 * Math.cos(36 * theta));
        const ripple =
          0.22 * Math.sin(rad * 1.35 - 4 * theta) * (1 - Math.min(Math.max(rad / 37, 0), 1));
        z = Math.min(Math.max(dish + Math.max(p8, p16, dome) + beads + ripple, -8.8), -0.15);
      }
      if (first) {
        lines.push(`G0 X${x.toFixed(3)} Y${y.toFixed(3)}`);
        lines.push(`G1 Z${z.toFixed(3)} F800`);
        lines.push("F3200");
        first = false;
      } else {
        lines.push(`G1 X${x.toFixed(3)} Y${y.toFixed(3)} Z${z.toFixed(3)}`);
      }
    }
  }
  const fr = 36.8;
  lines.push("G0 Z5.000");
  lines.push(`G0 X${fr.toFixed(3)} Y0.000`);
  lines.push("G1 Z-7.800 F600");
  lines.push(`G2 X${(-fr).toFixed(3)} Y0.000 I${(-fr).toFixed(3)} J0.000 F2200`);
  lines.push(`G2 X${fr.toFixed(3)} Y0.000 I${fr.toFixed(3)} J0.000`);
  lines.push("G0 Z10.000");
  lines.push("M30");

  return {
    text: lines.join("\n"),
    name: "lotus_relief_medallion.tap",
    ext: "tap",
  };
}

export function parseGcodeInBrowser(text: string, fileName: string, fileExt: string): ParsedWebGcode {
  const t0 = performance.now();
  const rawLines = text.split(/\r?\n/);
  const previewLines = rawLines.length > 300000 ? rawLines.slice(0, 300000) : rawLines;

  let cap = Math.max(rawLines.length * 2, 1024);
  let buf = new ArrayBuffer(cap * 32);
  let f32 = new Float32Array(buf);
  let u32 = new Uint32Array(buf);
  let segCount = 0;

  let rapidSegs = 0;
  let cutSegs = 0;
  let rapidLen = 0;
  let cutLen = 0;
  let cutTimeSec = 0;
  const cutMin: [number, number, number] = [Infinity, Infinity, Infinity];
  const cutMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const pushRaw = (
    p0: [number, number, number],
    p1: [number, number, number],
    isCut: boolean,
    feed: number,
    lineNo: number
  ) => {
    if (segCount >= cap) {
      cap *= 2;
      const next = new ArrayBuffer(cap * 32);
      new Uint8Array(next).set(new Uint8Array(buf));
      buf = next;
      f32 = new Float32Array(buf);
      u32 = new Uint32Array(buf);
    }
    const base = segCount * 8;
    f32[base + 0] = p0[0];
    f32[base + 1] = p0[1];
    f32[base + 2] = p0[2];
    const feedQ = (Math.min(Math.max(Math.round(feed * 0.5), 0), 65535) << 16) >>> 0;
    u32[base + 3] = ((isCut ? 1 : 0) | (1 << 8) | feedQ) >>> 0;
    f32[base + 4] = p1[0];
    f32[base + 5] = p1[1];
    f32[base + 6] = p1[2];
    u32[base + 7] = lineNo >>> 0;
    segCount++;
  };

  const emitSeg = (
    p0: [number, number, number],
    p1: [number, number, number],
    isCut: boolean,
    feed: number,
    lineNo: number
  ) => {
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const dz = p1[2] - p0[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-5) return;
    if (isCut) {
      cutSegs++;
      cutLen += dist;
      cutTimeSec += (dist / Math.max(feed, 10)) * 60;
      for (let a = 0; a < 3; a++) {
        cutMin[a] = Math.min(cutMin[a], p0[a], p1[a]);
        cutMax[a] = Math.max(cutMax[a], p0[a], p1[a]);
      }
      if (dist > 2.5) {
        const steps = Math.min(Math.ceil(dist / 2.5), 256);
        let prev = p0;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const pt: [number, number, number] =
            s === steps ? p1 : [p0[0] + dx * t, p0[1] + dy * t, p0[2] + dz * t];
          pushRaw(prev, pt, true, feed, lineNo);
          prev = pt;
        }
        return;
      }
    } else {
      rapidSegs++;
      rapidLen += dist;
    }
    pushRaw(p0, p1, isCut, feed, lineNo);
  };

  let motion: "G0" | "G1" | "G2" | "G3" | "G81" = "G0";
  let absMode = true;
  let unitScale = 1.0;
  let pos: [number, number, number] = [0, 0, 20];
  let inited = false;
  let feed = 1200;
  let cannedR = 2.0;
  let cannedZ = -5.0;

  let stockHint: { min: [number, number, number]; max: [number, number, number] } | null = null;
  let toolHintD: number | null = null;
  let toolHintCr: number | null = null;
  let toolHintAng: number | null = null;
  let toolHintKind: ToolSpec["kind"] | null = null;

  const wordRe = /([A-Z])\s*([+-]?\d*\.?\d+)/gi;

  for (let li = 0; li < rawLines.length; li++) {
    const raw = rawLines[li];
    if (!raw) continue;
    if (li < 60 && (raw.includes("(") || raw.includes(";"))) {
      const up = raw.toUpperCase();
      if (up.includes("STOCK/BLOCK")) {
        const nums = (up.match(/[+-]?\d+\.?\d*/g) || []).map(Number);
        if (nums.length >= 6) {
          stockHint = {
            min: [-nums[3], -nums[4], -nums[5]],
            max: [nums[0] - nums[3], nums[1] - nums[4], nums[2] - nums[5]],
          };
        }
      }
      if (up.includes("D=")) {
        const dm = up.match(/D=([\d.]+)/);
        if (dm) toolHintD = Number(dm[1]);
        const crm = up.match(/CR=([\d.]+)/);
        if (crm) toolHintCr = Number(crm[1]);
        const tm = up.match(/TAPER=([\d.]+)/);
        if (tm) toolHintAng = Number(tm[1]);
        if (up.includes("TAPER") && up.includes("BALL")) toolHintKind = "tapered_ball_nose";
        else if (up.includes("BALL")) toolHintKind = "ball_nose";
        else if (up.includes("FLAT")) toolHintKind = "flat_end_mill";
      }
    }

    const clean = raw.replace(/\([^)]*\)/g, "").split(";")[0];
    if (!clean.trim()) continue;

    let tx: number | undefined;
    let ty: number | undefined;
    let tz: number | undefined;
    let ai = 0;
    let aj = 0;
    let ar: number | undefined;
    let hasXyz = false;

    wordRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(clean)) !== null) {
      const code = m[1].toUpperCase();
      const val = parseFloat(m[2]);
      if (code === "G") {
        const g = Math.round(val * 10);
        if (g === 0) motion = "G0";
        else if (g === 10) motion = "G1";
        else if (g === 20) motion = "G2";
        else if (g === 30) motion = "G3";
        else if (g === 200) unitScale = 25.4;
        else if (g === 210) unitScale = 1.0;
        else if (g === 800) motion = "G0";
        else if (g === 810 || g === 820 || g === 830) motion = "G81";
        else if (g === 900) absMode = true;
        else if (g === 910) absMode = false;
      } else if (code === "X") {
        tx = val * unitScale;
        hasXyz = true;
      } else if (code === "Y") {
        ty = val * unitScale;
        hasXyz = true;
      } else if (code === "Z") {
        tz = val * unitScale;
        hasXyz = true;
      } else if (code === "I") ai = val * unitScale;
      else if (code === "J") aj = val * unitScale;
      else if (code === "R") ar = val * unitScale;
      else if (code === "F" && val > 0) feed = val * unitScale;
    }

    if (!hasXyz) continue;
    if (motion === "G81") {
      if (ar !== undefined) cannedR = absMode ? ar : pos[2] + ar;
      if (tz !== undefined) cannedZ = absMode ? tz : pos[2] + tz;
    }

    const nx = tx !== undefined ? (absMode ? tx : pos[0] + tx) : pos[0];
    const ny = ty !== undefined ? (absMode ? ty : pos[1] + ty) : pos[1];
    const nz =
      motion === "G81"
        ? cannedZ
        : tz !== undefined
        ? absMode
          ? tz
          : pos[2] + tz
        : pos[2];

    if (!inited && motion === "G0") {
      pos = [nx, ny, nz];
      if (tx !== undefined && ty !== undefined) inited = true;
      continue;
    }
    inited = true;
    const lineNo = li + 1;
    const nextPos: [number, number, number] = [nx, ny, nz];

    if (motion === "G0") {
      emitSeg(pos, nextPos, false, feed, lineNo);
      pos = nextPos;
    } else if (motion === "G1") {
      emitSeg(pos, nextPos, true, feed, lineNo);
      pos = nextPos;
    } else if (motion === "G81") {
      const topZ = Math.max(pos[2], cannedR);
      const above: [number, number, number] = [nx, ny, topZ];
      const atR: [number, number, number] = [nx, ny, cannedR];
      const bot: [number, number, number] = [nx, ny, nz];
      emitSeg(pos, above, false, feed, lineNo);
      emitSeg(above, atR, false, feed, lineNo);
      emitSeg(atR, bot, true, feed, lineNo);
      emitSeg(bot, atR, false, feed, lineNo);
      pos = atR;
    } else {
      const cw = motion === "G2";
      const cx = pos[0] + ai;
      const cy = pos[1] + aj;
      const r0 = Math.hypot(pos[0] - cx, pos[1] - cy);
      if (r0 < 1e-4) {
        emitSeg(pos, nextPos, true, feed, lineNo);
      } else {
        const a0 = Math.atan2(pos[1] - cy, pos[0] - cx);
        const a1 = Math.atan2(ny - cy, nx - cx);
        let sweep = a1 - a0;
        if (cw && sweep >= -1e-6) sweep -= Math.PI * 2;
        else if (!cw && sweep <= 1e-6) sweep += Math.PI * 2;
        const steps = Math.min(Math.max(Math.ceil((Math.abs(sweep) * r0) / 0.35), 8), 240);
        let prev = pos;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const ang = a0 + sweep * t;
          const pt: [number, number, number] =
            s === steps
              ? nextPos
              : [cx + r0 * Math.cos(ang), cy + r0 * Math.sin(ang), pos[2] + (nz - pos[2]) * t];
          emitSeg(prev, pt, true, feed, lineNo);
          prev = pt;
        }
      }
      pos = nextPos;
    }
  }

  if (!Number.isFinite(cutMin[0])) {
    cutMin[0] = -40; cutMin[1] = -40; cutMin[2] = -10;
    cutMax[0] = 40; cutMax[1] = 40; cutMax[2] = 0;
  }

  const isTap = fileExt.toLowerCase() === "tap";
  const tool: ToolSpec = toolHintD
    ? {
        id: 1,
        kind: toolHintKind ?? (isTap ? "tapered_ball_nose" : "flat_end_mill"),
        diameter: toolHintD,
        tip_radius: toolHintCr ?? (isTap ? 0.4 : 0),
        half_angle_deg: toolHintAng ?? (isTap ? 3.5 : 0),
        flute_length: Math.max(toolHintD * 4, 22),
        inferred: false,
      }
    : isTap
    ? {
        id: 1,
        kind: "tapered_ball_nose",
        diameter: 3.175,
        tip_radius: 0.4,
        half_angle_deg: 3.5,
        flute_length: 25,
        inferred: true,
      }
    : {
        id: 1,
        kind: "flat_end_mill",
        diameter: 6.0,
        tip_radius: 0.0,
        half_angle_deg: 0.0,
        flute_length: 24,
        inferred: true,
      };

  const pad = tool.diameter * 0.5 + 3.0;
  const stock: StockSpec = stockHint
    ? { min: stockHint.min, max: stockHint.max, inferred: false }
    : {
        min: [cutMin[0] - pad, cutMin[1] - pad, cutMin[2] - 3.0],
        max: [cutMax[0] + pad, cutMax[1] + pad, cutMin[2] < 0 && cutMax[2] <= 0.5 ? 0 : cutMax[2]],
        inferred: true,
      };

  const parseMs = performance.now() - t0;
  return {
    segmentsBuffer: buf.slice(0, segCount * 32),
    dto: {
      stats: {
        file_name: fileName,
        file_size_bytes: text.length,
        total_lines: rawLines.length,
        segment_count: segCount,
        rapid_segment_count: rapidSegs,
        cut_segment_count: cutSegs,
        rapid_length_mm: rapidLen,
        cut_length_mm: cutLen,
        estimated_time_sec: cutTimeSec + (rapidLen / 4000) * 60,
        parse_time_ms: parseMs,
        cut_bounds_min: cutMin,
        cut_bounds_max: cutMax,
      },
      stock,
      tool,
      default_material_id: 6,
      preview_lines: previewLines,
    },
  };
}
