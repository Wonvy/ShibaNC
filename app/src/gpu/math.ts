// Column-major 4x4 matrix helpers for WebGPU right-handed [0, 1] depth clip space.

export function perspectiveRhZeroToOne(
  fovYRad: number,
  aspect: number,
  near: number,
  far: number
): Float32Array {
  const f = 1.0 / Math.tan(fovYRad * 0.5);
  const nf = 1.0 / (near - far);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far * nf;
  out[11] = -1.0;
  out[14] = near * far * nf;
  return out;
}

export function orthoRhZeroToOne(
  halfW: number,
  halfH: number,
  near: number,
  far: number
): Float32Array {
  const nf = 1.0 / (near - far);
  const out = new Float32Array(16);
  out[0] = 1.0 / Math.max(halfW, 1e-4);
  out[5] = 1.0 / Math.max(halfH, 1e-4);
  out[10] = nf;
  out[14] = near * nf;
  out[15] = 1.0;
  return out;
}

export function lookAtRh(
  eye: [number, number, number],
  target: [number, number, number],
  up: [number, number, number]
): Float32Array {
  let fx = target[0] - eye[0];
  let fy = target[1] - eye[1];
  let fz = target[2] - eye[2];
  const flen = Math.hypot(fx, fy, fz) || 1.0;
  fx /= flen;
  fy /= flen;
  fz /= flen;

  // s = normalize(cross(f, up))
  let sx = fy * up[2] - fz * up[1];
  let sy = fz * up[0] - fx * up[2];
  let sz = fx * up[1] - fy * up[0];
  const slen = Math.hypot(sx, sy, sz) || 1.0;
  sx /= slen;
  sy /= slen;
  sz /= slen;

  // u = cross(s, f)
  const ux = sy * fz - sz * fy;
  const uy = sz * fx - sx * fz;
  const uz = sx * fy - sy * fx;

  const out = new Float32Array(16);
  out[0] = sx;
  out[1] = ux;
  out[2] = -fx;
  out[3] = 0;

  out[4] = sy;
  out[5] = uy;
  out[6] = -fy;
  out[7] = 0;

  out[8] = sz;
  out[9] = uz;
  out[10] = -fz;
  out[11] = 0;

  out[12] = -(sx * eye[0] + sy * eye[1] + sz * eye[2]);
  out[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
  out[14] = fx * eye[0] + fy * eye[1] + fz * eye[2];
  out[15] = 1.0;
  return out;
}

export function mulMat4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4 + 0];
    const b1 = b[col * 4 + 1];
    const b2 = b[col * 4 + 2];
    const b3 = b[col * 4 + 3];
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b0 +
        a[1 * 4 + row] * b1 +
        a[2 * 4 + row] * b2 +
        a[3 * 4 + row] * b3;
    }
  }
  return out;
}

export function invertMat4(m: Float32Array): Float32Array | null {
  const inv = new Float32Array(16);

  inv[0] =
    m[5] * m[10] * m[15] -
    m[5] * m[11] * m[14] -
    m[9] * m[6] * m[15] +
    m[9] * m[7] * m[14] +
    m[13] * m[6] * m[11] -
    m[13] * m[7] * m[10];

  inv[4] =
    -m[4] * m[10] * m[15] +
    m[4] * m[11] * m[14] +
    m[8] * m[6] * m[15] -
    m[8] * m[7] * m[14] -
    m[12] * m[6] * m[11] +
    m[12] * m[7] * m[10];

  inv[8] =
    m[4] * m[9] * m[15] -
    m[4] * m[11] * m[13] -
    m[8] * m[5] * m[15] +
    m[8] * m[7] * m[13] +
    m[12] * m[5] * m[11] -
    m[12] * m[7] * m[9];

  inv[12] =
    -m[4] * m[9] * m[14] +
    m[4] * m[10] * m[13] +
    m[8] * m[5] * m[14] -
    m[8] * m[6] * m[13] -
    m[12] * m[5] * m[10] +
    m[12] * m[6] * m[9];

  inv[1] =
    -m[1] * m[10] * m[15] +
    m[1] * m[11] * m[14] +
    m[9] * m[2] * m[15] -
    m[9] * m[3] * m[14] -
    m[13] * m[2] * m[11] +
    m[13] * m[3] * m[10];

  inv[5] =
    m[0] * m[10] * m[15] -
    m[0] * m[11] * m[14] -
    m[8] * m[2] * m[15] +
    m[8] * m[3] * m[14] +
    m[12] * m[2] * m[11] -
    m[12] * m[3] * m[10];

  inv[9] =
    -m[0] * m[9] * m[15] +
    m[0] * m[11] * m[13] +
    m[8] * m[1] * m[15] -
    m[8] * m[3] * m[13] -
    m[12] * m[1] * m[11] +
    m[12] * m[3] * m[9];

  inv[13] =
    m[0] * m[9] * m[14] -
    m[0] * m[10] * m[13] -
    m[8] * m[1] * m[14] +
    m[8] * m[2] * m[13] +
    m[12] * m[1] * m[10] -
    m[12] * m[2] * m[9];

  inv[2] =
    m[1] * m[6] * m[15] -
    m[1] * m[7] * m[14] -
    m[5] * m[2] * m[15] +
    m[5] * m[3] * m[14] +
    m[13] * m[2] * m[7] -
    m[13] * m[3] * m[6];

  inv[6] =
    -m[0] * m[6] * m[15] +
    m[0] * m[7] * m[14] +
    m[4] * m[2] * m[15] -
    m[4] * m[3] * m[14] -
    m[12] * m[2] * m[7] +
    m[12] * m[3] * m[6];

  inv[10] =
    m[0] * m[5] * m[15] -
    m[0] * m[7] * m[13] -
    m[4] * m[1] * m[15] +
    m[4] * m[3] * m[13] +
    m[12] * m[1] * m[7] -
    m[12] * m[3] * m[5];

  inv[14] =
    -m[0] * m[5] * m[14] +
    m[0] * m[6] * m[13] +
    m[4] * m[1] * m[14] -
    m[4] * m[2] * m[13] -
    m[12] * m[1] * m[6] +
    m[12] * m[2] * m[5];

  inv[3] =
    -m[1] * m[6] * m[11] +
    m[1] * m[7] * m[10] +
    m[5] * m[2] * m[11] -
    m[5] * m[3] * m[10] -
    m[9] * m[2] * m[7] +
    m[9] * m[3] * m[6];

  inv[7] =
    m[0] * m[6] * m[11] -
    m[0] * m[7] * m[10] -
    m[4] * m[2] * m[11] +
    m[4] * m[3] * m[10] +
    m[8] * m[2] * m[7] -
    m[8] * m[3] * m[6];

  inv[11] =
    -m[0] * m[5] * m[11] +
    m[0] * m[7] * m[9] +
    m[4] * m[1] * m[11] -
    m[4] * m[3] * m[9] -
    m[8] * m[1] * m[7] +
    m[8] * m[3] * m[5];

  inv[15] =
    m[0] * m[5] * m[10] -
    m[0] * m[6] * m[9] -
    m[4] * m[1] * m[10] +
    m[4] * m[2] * m[9] +
    m[8] * m[1] * m[6] -
    m[8] * m[2] * m[5];

  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (Math.abs(det) < 1e-12) {
    return null;
  }
  const invDet = 1.0 / det;
  for (let i = 0; i < 16; i++) {
    inv[i] *= invDet;
  }
  return inv;
}

export function unprojectPoint(
  invViewProj: Float32Array,
  ndcX: number,
  ndcY: number,
  ndcZ: number
): [number, number, number] {
  const x =
    invViewProj[0] * ndcX +
    invViewProj[4] * ndcY +
    invViewProj[8] * ndcZ +
    invViewProj[12];
  const y =
    invViewProj[1] * ndcX +
    invViewProj[5] * ndcY +
    invViewProj[9] * ndcZ +
    invViewProj[13];
  const z =
    invViewProj[2] * ndcX +
    invViewProj[6] * ndcY +
    invViewProj[10] * ndcZ +
    invViewProj[14];
  const w =
    invViewProj[3] * ndcX +
    invViewProj[7] * ndcY +
    invViewProj[11] * ndcZ +
    invViewProj[15];
  const invW = Math.abs(w) > 1e-7 ? 1.0 / w : 1.0;
  return [x * invW, y * invW, z * invW];
}

export function projectPointToCss(
  viewProj: Float32Array,
  p: [number, number, number],
  cssW: number,
  cssH: number
): { x: number; y: number; visible: boolean } {
  const cx =
    viewProj[0] * p[0] + viewProj[4] * p[1] + viewProj[8] * p[2] + viewProj[12];
  const cy =
    viewProj[1] * p[0] + viewProj[5] * p[1] + viewProj[9] * p[2] + viewProj[13];
  const w =
    viewProj[3] * p[0] + viewProj[7] * p[1] + viewProj[11] * p[2] + viewProj[15];
  if (w <= 1e-4) {
    return { x: -9999, y: -9999, visible: false };
  }
  const ndcX = cx / w;
  const ndcY = cy / w;
  return {
    x: (ndcX * 0.5 + 0.5) * cssW,
    y: (0.5 - ndcY * 0.5) * cssH,
    visible: ndcX >= -1.5 && ndcX <= 1.5 && ndcY >= -1.5 && ndcY <= 1.5,
  };
}
