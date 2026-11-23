import {
  CameraState,
  SegmentTipInfo,
  StockSpec,
  TOOL_KIND_CODE,
  ToolSpec,
} from "../types";
import {
  invertMat4,
  lookAtRh,
  mulMat4,
  orthoRhZeroToOne,
  perspectiveRhZeroToOne,
  projectPointToCss,
  unprojectPoint,
} from "./math";
import type { ViewportEngine, ViewportRenderParams } from "./WebGpuViewport";

const Z_SCALE = 10000.0;

const PART_VS_GLSL = `#version 300 es
precision highp float;
precision highp int;

uniform mat4 uViewProj;
uniform vec4 uCameraPos;
uniform vec4 uStockMin;
uniform vec4 uStockMax;
uniform vec4 uGridInfo;
uniform vec4 uStyleInfo;
uniform vec4 uCutterPos;
uniform vec4 uCutterGeom;
uniform vec4 uSectionInfo;
uniform sampler2D uHeightTex;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vGridUv;
out float vRawZ;
flat out int vPartZone;

const float PI = 3.14159265359;

float readRawZ(int ix, int iy) {
  int gw = int(uGridInfo.x + 0.5);
  int gh = int(uGridInfo.y + 0.5);
  int cx = clamp(ix, 0, gw - 1);
  int cy = clamp(iy, 0, gh - 1);
  return texelFetch(uHeightTex, ivec2(cx, cy), 0).r;
}

float readClampedZ(int ix, int iy) {
  return clamp(readRawZ(ix, iy), uStockMin.z, uStockMax.z);
}

float sampleRawZWorld(float wx, float wy) {
  int gw = int(uGridInfo.x + 0.5);
  int gh = int(uGridInfo.y + 0.5);
  float fx = clamp((wx - uStockMin.x) / max(uGridInfo.z, 1e-5), 0.0, float(gw - 1));
  float fy = clamp((wy - uStockMin.y) / max(uGridInfo.w, 1e-5), 0.0, float(gh - 1));
  int ix = min(int(floor(fx)), gw - 2);
  int iy = min(int(floor(fy)), gh - 2);
  float tx = fx - float(ix);
  float ty = fy - float(iy);
  float z00 = readRawZ(ix, iy);
  float z10 = readRawZ(ix + 1, iy);
  float z01 = readRawZ(ix, iy + 1);
  float z11 = readRawZ(ix + 1, iy + 1);
  return mix(mix(z00, z10, tx), mix(z01, z11, tx), ty);
}

vec3 gridWorldPos(int ix, int iy) {
  return vec3(
    uStockMin.x + float(ix) * uGridInfo.z,
    uStockMin.y + float(iy) * uGridInfo.w,
    readClampedZ(ix, iy)
  );
}

vec3 computeCreaseNormal(int ix, int iy, vec3 triNormal) {
  if (triNormal.z < 0.68) {
    return triNormal;
  }
  float dx = uGridInfo.z;
  float dy = uGridInfo.w;
  float zc = readClampedZ(ix, iy);
  float zlRaw = readClampedZ(ix - 1, iy);
  float zrRaw = readClampedZ(ix + 1, iy);
  float zdRaw = readClampedZ(ix, iy - 1);
  float zuRaw = readClampedZ(ix, iy + 1);

  float cliffThresh = max(dx, dy) * 2.2;
  float zl = abs(zlRaw - zc) > cliffThresh ? zc : zlRaw;
  float zr = abs(zrRaw - zc) > cliffThresh ? zc : zrRaw;
  float zd = abs(zdRaw - zc) > cliffThresh ? zc : zdRaw;
  float zu = abs(zuRaw - zc) > cliffThresh ? zc : zuRaw;

  float spanX = (zl == zc || zr == zc) ? dx : 2.0 * dx;
  float spanY = (zd == zc || zu == zc) ? dy : 2.0 * dy;
  float dzdx = (zr - zl) / max(spanX, 1e-5);
  float dzdy = (zu - zd) / max(spanY, 1e-5);
  return normalize(vec3(-dzdx, -dzdy, 1.0));
}

vec2 cutterProfileRAndZ(float vNorm) {
  float outerR = max(uCutterPos.w, 0.2);
  int kind = int(floor(uCutterGeom.x + 0.5));
  float tipR = clamp(uCutterGeom.y, 0.0, outerR);
  float alpha = clamp(uCutterGeom.z, 0.008, 1.48);
  float fluteH = max(uCutterGeom.w, outerR * 3.0);

  if (vNorm <= 0.65) {
    float t = vNorm / 0.65;
    float zLocal = t * fluteH;
    float rLocal = outerR;
    if (kind == 1) {
      if (zLocal < outerR) {
        float dz = outerR - zLocal;
        rLocal = sqrt(max(outerR * outerR - dz * dz, 0.0));
      }
    } else if (kind == 3) {
      if (zLocal < tipR && tipR > 1e-4) {
        float dz = tipR - zLocal;
        rLocal = (outerR - tipR) + sqrt(max(tipR * tipR - dz * dz, 0.0));
      }
    } else if (kind == 2 || kind == 4) {
      float zTan = tipR * (1.0 - sin(alpha));
      float rTan = tipR * cos(alpha);
      if (zLocal <= zTan && tipR > 1e-4) {
        float dz = tipR - zLocal;
        rLocal = sqrt(max(tipR * tipR - dz * dz, 0.0));
      } else {
        rLocal = min(rTan + (zLocal - zTan) * tan(alpha), outerR * 1.6);
      }
    }
    if (vNorm <= 0.001) {
      rLocal = 0.0;
    }
    return vec2(rLocal, zLocal);
  } else {
    float tShank = (vNorm - 0.65) / 0.35;
    float colletScale = tShank > 0.55 ? 1.65 : 1.0;
    float zLocal = fluteH + tShank * (fluteH * 0.65);
    float rLocal = vNorm >= 0.999 ? 0.0 : outerR * colletScale;
    return vec2(rLocal, zLocal);
  }
}

void finishPosition(vec3 wp) {
  vec4 cp = uViewProj * vec4(wp, 1.0);
  cp.z = cp.z * 2.0 - cp.w; // Remap [0, 1] clip depth to WebGL2 [-1, 1]
  gl_Position = cp;
}

void main() {
  int vid = gl_VertexID;
  int passKind = int(floor(uStyleInfo.y + 0.5));
  int gw = int(uGridInfo.x + 0.5);
  int gh = int(uGridInfo.y + 0.5);
  int cellsX = gw - 1;
  int cellsY = gh - 1;

  if (passKind == 0) {
    int quadIdx = vid / 6;
    int corner = vid % 6;
    int qx = quadIdx % cellsX;
    int qy = quadIdx / cellsX;

    vec3 p00 = gridWorldPos(qx, qy);
    vec3 p10 = gridWorldPos(qx + 1, qy);
    vec3 p01 = gridWorldPos(qx, qy + 1);
    vec3 p11 = gridWorldPos(qx + 1, qy + 1);

    int ox = 0;
    int oy = 0;
    vec3 triN = vec3(0.0, 0.0, 1.0);

    float diagA = abs(p11.z - p00.z);
    float diagB = abs(p10.z - p01.z);

    if (diagA <= diagB) {
      if (corner == 0) { ox = 0; oy = 0; triN = normalize(cross(p10 - p00, p11 - p00)); }
      else if (corner == 1) { ox = 1; oy = 0; triN = normalize(cross(p10 - p00, p11 - p00)); }
      else if (corner == 2) { ox = 1; oy = 1; triN = normalize(cross(p10 - p00, p11 - p00)); }
      else if (corner == 3) { ox = 0; oy = 0; triN = normalize(cross(p11 - p00, p01 - p00)); }
      else if (corner == 4) { ox = 1; oy = 1; triN = normalize(cross(p11 - p00, p01 - p00)); }
      else { ox = 0; oy = 1; triN = normalize(cross(p11 - p00, p01 - p00)); }
    } else {
      if (corner == 0) { ox = 0; oy = 0; triN = normalize(cross(p10 - p00, p01 - p00)); }
      else if (corner == 1) { ox = 1; oy = 0; triN = normalize(cross(p10 - p00, p01 - p00)); }
      else if (corner == 2) { ox = 0; oy = 1; triN = normalize(cross(p10 - p00, p01 - p00)); }
      else if (corner == 3) { ox = 1; oy = 0; triN = normalize(cross(p11 - p10, p01 - p10)); }
      else if (corner == 4) { ox = 1; oy = 1; triN = normalize(cross(p11 - p10, p01 - p10)); }
      else { ox = 0; oy = 1; triN = normalize(cross(p11 - p10, p01 - p10)); }
    }

    int ix = qx + ox;
    int iy = qy + oy;
    vec3 wp = gridWorldPos(ix, iy);
    vWorldPos = wp;
    vNormal = computeCreaseNormal(ix, iy, triN);
    vGridUv = vec2(float(ix), float(iy));
    vRawZ = readRawZ(ix, iy);
    vPartZone = 0;
    finishPosition(wp);
    return;
  }

  if (passKind == 1) {
    int segIdx = vid / 6;
    int corner = vid % 6;
    int nSouth = cellsX;
    int nNorth = cellsX;
    int nWest = cellsY;

    int ix0 = 0; int iy0 = 0;
    int ix1 = 0; int iy1 = 0;
    vec3 wallN = vec3(0.0, -1.0, 0.0);

    if (segIdx < nSouth) {
      int s = segIdx;
      ix0 = s; iy0 = 0; ix1 = s + 1; iy1 = 0;
      wallN = vec3(0.0, -1.0, 0.0);
    } else if (segIdx < nSouth + nNorth) {
      int s = segIdx - nSouth;
      ix0 = s + 1; iy0 = gh - 1; ix1 = s; iy1 = gh - 1;
      wallN = vec3(0.0, 1.0, 0.0);
    } else if (segIdx < nSouth + nNorth + nWest) {
      int s = segIdx - nSouth - nNorth;
      ix0 = 0; iy0 = s + 1; ix1 = 0; iy1 = s;
      wallN = vec3(-1.0, 0.0, 0.0);
    } else {
      int s = segIdx - nSouth - nNorth - nWest;
      ix0 = gw - 1; iy0 = s; ix1 = gw - 1; iy1 = s + 1;
      wallN = vec3(1.0, 0.0, 0.0);
    }

    vec3 top0 = gridWorldPos(ix0, iy0);
    vec3 top1 = gridWorldPos(ix1, iy1);
    vec3 bot0 = vec3(top0.x, top0.y, uStockMin.z);
    vec3 bot1 = vec3(top1.x, top1.y, uStockMin.z);

    vec3 wp = bot0;
    if (corner == 1) wp = bot1;
    else if (corner == 2 || corner == 4) wp = top1;
    else if (corner == 5) wp = top0;

    vWorldPos = wp;
    vNormal = wallN;
    vGridUv = vec2(float(ix0), float(iy0));
    vRawZ = uStockMax.z;
    vPartZone = 1;
    finishPosition(wp);
    return;
  }

  if (passKind == 2) {
    int quadIdx = vid / 6;
    int corner = vid % 6;
    int qx = quadIdx % cellsX;
    int qy = quadIdx / cellsX;
    int ox = (corner == 1 || corner == 2 || corner == 5) ? 1 : 0;
    int oy = (corner == 1 || corner == 4 || corner == 5) ? 1 : 0;
    int ix = qx + ox;
    int iy = qy + oy;
    vec3 wp = vec3(
      uStockMin.x + float(ix) * uGridInfo.z,
      uStockMin.y + float(iy) * uGridInfo.w,
      uStockMin.z
    );
    vWorldPos = wp;
    vNormal = vec3(0.0, 0.0, -1.0);
    vGridUv = vec2(float(ix), float(iy));
    vRawZ = readRawZ(ix, iy);
    vPartZone = 1;
    finishPosition(wp);
    return;
  }

  if (passKind == 3) {
    int slices = 32;
    int stacks = 24;
    int quadIdx = vid / 6;
    int corner = vid % 6;
    int si = quadIdx % slices;
    int ti = quadIdx / slices;
    int ds = (corner == 1 || corner == 2 || corner == 4) ? 1 : 0;
    int dt = (corner == 2 || corner == 4 || corner == 5) ? 1 : 0;

    float uAng = float(si + ds) / float(slices) * (2.0 * PI);
    float vNorm = float(ti + dt) / float(stacks);
    vec2 rz = cutterProfileRAndZ(vNorm);
    vec2 rzNext = cutterProfileRAndZ(clamp(vNorm + 0.02, 0.0, 0.99));
    float dr = rzNext.x - rz.x;
    float dz = max(rzNext.y - rz.y, 1e-4);

    if (vNorm > 0.03 && vNorm <= 0.63) {
      float fluteWave = 0.5 + 0.5 * cos(uAng * 4.0 - vNorm * 18.0);
      rz.x *= (0.90 + 0.10 * fluteWave);
    }

    float ca = cos(uAng);
    float sa = sin(uAng);
    vec3 wp = vec3(
      uCutterPos.x + rz.x * ca,
      uCutterPos.y + rz.x * sa,
      uCutterPos.z + rz.y
    );
    vec3 nRad = normalize(vec3(dz * ca, dz * sa, -dr));
    if (vNorm >= 0.95) nRad = vec3(0.0, 0.0, 1.0);
    else if (vNorm <= 0.005) nRad = vec3(0.0, 0.0, -1.0);

    vWorldPos = wp;
    vNormal = nRad;
    vGridUv = vec2(uAng, vNorm);
    vRawZ = wp.z;
    vPartZone = vNorm > 0.65 ? 3 : 2;
    finishPosition(wp);
    return;
  }

  if (passKind == 5) {
    int secAxis = int(floor(uSectionInfo.x + 0.5));
    float secPos = uSectionInfo.y;
    int segIdx = vid / 6;
    int corner = vid % 6;

    vec3 top0 = vec3(0.0);
    vec3 top1 = vec3(0.0);
    float raw0 = uStockMax.z;
    float raw1 = uStockMax.z;
    vec3 secN = vec3(-1.0, 0.0, 0.0);

    if (secAxis == 1) {
      int s = clamp(segIdx, 0, cellsY - 1);
      float y0 = uStockMin.y + float(s) * uGridInfo.w;
      float y1 = uStockMin.y + float(s + 1) * uGridInfo.w;
      raw0 = sampleRawZWorld(secPos, y0);
      raw1 = sampleRawZWorld(secPos, y1);
      top0 = vec3(secPos, y0, clamp(raw0, uStockMin.z, uStockMax.z));
      top1 = vec3(secPos, y1, clamp(raw1, uStockMin.z, uStockMax.z));
      secN = vec3(-1.0, 0.0, 0.0);
    } else {
      int s = clamp(segIdx, 0, cellsX - 1);
      float x0 = uStockMin.x + float(s) * uGridInfo.z;
      float x1 = uStockMin.x + float(s + 1) * uGridInfo.z;
      raw0 = sampleRawZWorld(x0, secPos);
      raw1 = sampleRawZWorld(x1, secPos);
      top0 = vec3(x0, secPos, clamp(raw0, uStockMin.z, uStockMax.z));
      top1 = vec3(x1, secPos, clamp(raw1, uStockMin.z, uStockMax.z));
      secN = vec3(0.0, -1.0, 0.0);
    }

    vec3 bot0 = vec3(top0.x, top0.y, uStockMin.z);
    vec3 bot1 = vec3(top1.x, top1.y, uStockMin.z);
    vec3 wp = bot0;
    float rzVal = raw0;
    if (corner == 1) { wp = bot1; rzVal = raw1; }
    else if (corner == 2 || corner == 4) { wp = top1; rzVal = raw1; }
    else if (corner == 5) { wp = top0; rzVal = raw0; }

    vWorldPos = wp;
    vNormal = secN;
    vGridUv = vec2(0.0);
    vRawZ = rzVal;
    vPartZone = 5;
    finishPosition(wp);
    return;
  }

  // Floor Grid Plane (passKind == 4)
  float cx = 0.5 * (uStockMin.x + uStockMax.x);
  float cy = 0.5 * (uStockMin.y + uStockMax.y);
  float span = max(uStockMax.x - uStockMin.x, uStockMax.y - uStockMin.y) * 1.45;
  float zFloor = uStockMin.z - 0.15;
  int c = vid % 6;
  vec2 uv = vec2(-1.0, -1.0);
  if (c == 1) uv = vec2(1.0, -1.0);
  else if (c == 2 || c == 4) uv = vec2(1.0, 1.0);
  else if (c == 5) uv = vec2(-1.0, 1.0);

  vec3 wp = vec3(cx + uv.x * span, cy + uv.y * span, zFloor);
  vWorldPos = wp;
  vNormal = vec3(0.0, 0.0, 1.0);
  vGridUv = uv;
  vRawZ = zFloor;
  vPartZone = 4;
  finishPosition(wp);
}
`;

const PART_FS_GLSL = `#version 300 es
precision highp float;
precision highp int;

uniform vec4 uCameraPos;
uniform vec4 uStockMin;
uniform vec4 uStockMax;
uniform vec4 uGridInfo;
uniform vec4 uStyleInfo;
uniform vec4 uSectionInfo;
uniform sampler2D uHeightTex;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vGridUv;
in float vRawZ;
flat in int vPartZone;

out vec4 fragColor;

float readClampedZ(int ix, int iy) {
  int gw = int(uGridInfo.x + 0.5);
  int gh = int(uGridInfo.y + 0.5);
  int cx = clamp(ix, 0, gw - 1);
  int cy = clamp(iy, 0, gh - 1);
  return clamp(texelFetch(uHeightTex, ivec2(cx, cy), 0).r, uStockMin.z, uStockMax.z);
}

float computeHeightfieldAo(vec2 gridUv, float centerZ) {
  float strength = uStyleInfo.z;
  if (strength <= 0.01) return 1.0;
  int ix = int(floor(gridUv.x + 0.5));
  int iy = int(floor(gridUv.y + 0.5));
  float cellSize = 0.5 * (uGridInfo.z + uGridInfo.w);

  ivec2 dirs[8] = ivec2[8](
    ivec2( 1,  0), ivec2(-1,  0),
    ivec2( 0,  1), ivec2( 0, -1),
    ivec2( 1,  1), ivec2(-1, -1),
    ivec2( 1, -1), ivec2(-1,  1)
  );
  int radii[3] = int[3](2, 5, 12);

  float occ = 0.0;
  for (int d = 0; d < 8; d++) {
    ivec2 dir = dirs[d];
    float diagScale = (dir.x != 0 && dir.y != 0) ? 1.4142 : 1.0;
    float maxSlope = 0.0;
    for (int rIdx = 0; rIdx < 3; rIdx++) {
      int stepR = radii[rIdx];
      float sz = readClampedZ(ix + dir.x * stepR, iy + dir.y * stepR);
      float dz = sz - centerZ;
      if (dz > 0.0) {
        float dist = float(stepR) * cellSize * diagScale;
        maxSlope = max(maxSlope, dz / max(dist, 1e-4));
      }
    }
    occ += maxSlope / (1.0 + maxSlope);
  }
  return clamp(1.0 - (occ / 8.0) * 0.88 * strength, 0.18, 1.0);
}

vec3 woodGrainAlbedo(vec3 wp) {
  vec3 p = wp * vec3(0.09, 0.035, 0.24);
  float wobble = sin(p.x * 2.1 + p.y * 3.2) * 0.36 + cos(p.y * 4.6 - p.z * 1.5) * 0.20;
  float ringDist = length(vec2(p.x + 14.0, p.z * 1.4 + 9.0)) * 2.2 + wobble;
  float ring = 0.5 + 0.5 * sin(ringDist * 6.28318);
  float pore = 0.5 + 0.5 * sin(wp.x * 18.0 + wp.y * 2.8);
  return mix(vec3(0.62, 0.36, 0.20), vec3(0.42, 0.22, 0.11), smoothstep(0.22, 0.85, ring)) * (0.96 + 0.04 * pore);
}

vec3 pineWoodAlbedo(vec3 wp) {
  vec3 p = wp * vec3(0.068, 0.024, 0.19);
  float wobble = sin(p.x * 1.6 + p.y * 2.4) * 0.42 + cos(p.y * 3.6 + p.z * 1.2) * 0.22;
  float ringDist = length(vec2(p.x + 18.0, p.z * 1.35 + 11.0)) * 1.85 + wobble;
  float wave = 0.5 + 0.5 * sin(ringDist * 6.28318);
  float fiber = 0.5 + 0.5 * sin(wp.y * 9.0 + wp.x * 2.2);
  return mix(vec3(0.91, 0.81, 0.63), vec3(0.73, 0.53, 0.32), smoothstep(0.62, 0.94, wave)) * (0.98 + 0.02 * fiber);
}

vec3 depthHeatmapAlbedo(float tRaw) {
  float t = clamp(tRaw, 0.0, 1.0);
  vec3 c0 = vec3(0.18, 0.34, 0.82);
  vec3 c1 = vec3(0.06, 0.72, 0.86);
  vec3 c2 = vec3(0.16, 0.80, 0.44);
  vec3 c3 = vec3(0.96, 0.82, 0.18);
  vec3 c4 = vec3(0.92, 0.24, 0.18);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}

void main() {
  float fwx = max(fwidth(vWorldPos.x / 10.0), 1e-5);
  float fwy = max(fwidth(vWorldPos.y / 10.0), 1e-5);
  float fwZmm = max(fwidth(vWorldPos.z), 1e-5);
  float hatchCoord = (vWorldPos.x + vWorldPos.y + vWorldPos.z) * 0.85;
  float fwHatch = max(fwidth(hatchCoord), 1e-5);
  bool isLight = uStockMin.w > 0.5;

  if (vPartZone == 4) {
    float gx = abs(fract(vWorldPos.x / 10.0 - 0.5) - 0.5) / fwx;
    float gy = abs(fract(vWorldPos.y / 10.0 - 0.5) - 0.5) / fwy;
    float lineAlpha = 1.0 - clamp(min(gx, gy), 0.0, 1.0);
    float distFade = 1.0 - smoothstep(0.32, 0.98, length(vGridUv));
    vec3 baseFloor = isLight ? vec3(0.945, 0.948, 0.958) : vec3(0.045, 0.045, 0.055);
    vec3 gridLine = isLight ? vec3(0.76, 0.78, 0.82) : vec3(0.19, 0.20, 0.23);
    fragColor = vec4(mix(baseFloor, gridLine, lineAlpha * 0.72), distFade * 0.75);
    return;
  }

  int secAxis = int(floor(uSectionInfo.x + 0.5));
  if (vPartZone <= 1) {
    if (secAxis == 1 && vWorldPos.x < uSectionInfo.y - 1e-4) discard;
    if (secAxis == 2 && vWorldPos.y < uSectionInfo.y - 1e-4) discard;
  }

  if ((vPartZone == 0 || vPartZone == 1 || vPartZone == 5) && vRawZ < uStockMin.z - 0.03) {
    discard;
  }

  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCameraPos.xyz - vWorldPos);
  vec3 LKey  = normalize(vec3(-0.48, -0.58, 0.66));
  vec3 LFill = normalize(vec3( 0.68, -0.25, 0.68));
  vec3 LRim  = normalize(vec3( 0.15,  0.82, 0.55));

  int matId = int(floor(uStyleInfo.x + 0.5));
  vec3 albedo = vec3(0.76, 0.79, 0.83);
  float metallic = 0.78;
  float roughness = 0.28;

  if (vPartZone == 2) {
    float helix = vGridUv.x * 4.0 - vGridUv.y * 18.0;
    float fluteCrest = 0.5 + 0.5 * cos(helix);
    vec3 tangU = vec3(-sin(vGridUv.x), cos(vGridUv.x), 0.0);
    N = normalize(N + tangU * sin(helix) * 0.34 + vec3(0.0, 0.0, 0.16));
    albedo = mix(vec3(0.68, 0.73, 0.80), vec3(0.95, 0.97, 1.0), fluteCrest);
    metallic = 0.72;
    roughness = 0.20;
  } else if (vPartZone == 3) {
    bool isCollet = vGridUv.y > 0.84;
    N = normalize(N + vec3(0.0, 0.0, 0.14));
    albedo = isCollet ? vec3(0.70, 0.74, 0.80) : vec3(0.88, 0.91, 0.95);
    metallic = 0.70;
    roughness = isCollet ? 0.28 : 0.18;
  } else {
    if (matId == 0) {
      bool isUncutTop = vPartZone == 0 && vRawZ >= uStockMax.z - 0.002;
      albedo = isUncutTop ? vec3(0.66, 0.70, 0.76) : vec3(0.79, 0.83, 0.88);
      metallic = 0.82;
      roughness = isUncutTop ? 0.36 : 0.24;
    } else if (matId == 1) {
      albedo = woodGrainAlbedo(vWorldPos);
      metallic = 0.06;
      roughness = 0.46;
    } else if (matId == 2) {
      bool isUncutTop = vPartZone == 0 && vRawZ >= uStockMax.z - 0.002;
      albedo = isUncutTop ? vec3(0.75, 0.60, 0.29) : vec3(0.91, 0.74, 0.36);
      metallic = 0.86;
      roughness = 0.23;
    } else if (matId == 4) {
      albedo = pineWoodAlbedo(vWorldPos);
      metallic = 0.03;
      roughness = 0.54;
    } else if (matId == 5) {
      float zSpan = max(uStockMax.z - uStockMin.z, 0.1);
      float depthT = clamp((uStockMax.z - vWorldPos.z) / zSpan, 0.0, 1.0);
      vec3 baseHeat = depthHeatmapAlbedo(depthT);
      float isoDist = abs(fract(vWorldPos.z - 0.5) - 0.5) / fwZmm;
      float isoLine = (1.0 - smoothstep(0.0, 1.2, isoDist)) * (N.z > 0.98 ? 0.0 : 0.28);
      albedo = mix(baseHeat, baseHeat * 0.55, isoLine);
      metallic = 0.08;
      roughness = 0.42;
    } else {
      albedo = vec3(0.48, 0.76, 0.66);
      metallic = 0.05;
      roughness = 0.26;
    }

    if (vPartZone == 5) {
      float hd = abs(fract(hatchCoord - 0.5) - 0.5) / fwHatch;
      float hline = 1.0 - smoothstep(0.0, 1.2, hd);
      albedo = mix(albedo * 0.94, albedo * 0.68, hline * 0.55);
      metallic *= 0.35;
      roughness = max(roughness, 0.48);
    }
  }

  float ao = vPartZone == 0 ? computeHeightfieldAo(vGridUv, vWorldPos.z) : 1.0;

  float ndlKey  = max(dot(N, LKey), 0.0);
  float ndlFill = max(dot(N, LFill), 0.0);
  float ndlRim  = max(dot(N, LRim), 0.0);

  vec3 HKey  = normalize(LKey + V);
  vec3 HFill = normalize(LFill + V);
  vec3 HRim  = normalize(LRim + V);

  float shininess = mix(190.0, 14.0, roughness);
  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  vec3 fresnel = f0 + (vec3(1.0) - f0) * pow(1.0 - max(dot(N, V), 0.0), 5.0);

  float specNorm = (shininess + 8.0) / 25.1327;
  float specKey  = pow(max(dot(N, HKey), 0.0), shininess) * specNorm * ndlKey;
  float specFill = pow(max(dot(N, HFill), 0.0), shininess * 0.7) * specNorm * 0.45 * ndlFill;
  float specRim  = pow(max(dot(N, HRim), 0.0), shininess * 0.8) * specNorm * 0.55 * ndlRim;

  vec3 kd = (vec3(1.0) - fresnel) * (1.0 - metallic * 0.72);
  vec3 hemi = mix(vec3(0.16, 0.18, 0.22), vec3(0.46, 0.50, 0.58), N.z * 0.5 + 0.5);

  vec3 color = kd * albedo * (hemi * 0.75 + ndlKey * vec3(1.05, 1.02, 0.98) + ndlFill * vec3(0.45, 0.52, 0.62) + ndlRim * vec3(0.32, 0.36, 0.42));
  color += fresnel * (specKey * vec3(1.05, 1.02, 0.98) + specFill * vec3(0.65, 0.75, 0.92) + specRim * vec3(0.55, 0.65, 0.80));

  vec3 R = reflect(-V, N);
  float skyBand = smoothstep(-0.35, 0.65, R.z) * (0.65 + 0.35 * sin(R.x * 3.0 + R.y * 2.0));
  float horiz = 1.0 - abs(R.z) * 0.55;
  float stripA = pow(max(dot(normalize(vec2(R.x, R.y) + vec2(1e-5)), vec2(-0.6, -0.8)), 0.0), 4.0);
  float stripB = pow(max(dot(normalize(vec2(R.x, R.y) + vec2(1e-5)), vec2( 0.85, 0.52)), 0.0), 6.0);
  float studioEnv = skyBand * 0.32 + horiz * (0.22 + stripA * 0.55 + stripB * 0.38);
  color += f0 * metallic * studioEnv;

  if (matId == 3 && vPartZone == 0) {
    float sss = pow(clamp(1.0 - ao + 0.35, 0.0, 1.0), 1.5) * 0.18;
    color += vec3(0.22, 0.55, 0.42) * sss;
  }

  color *= ao;

  vec3 finalRgb = clamp(
    (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14),
    vec3(0.0),
    vec3(1.0)
  );
  fragColor = vec4(finalRgb, 1.0);
}
`;

const LINE_VS_GLSL = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec4 aSegVert; // xyz = pos, w = isCut (0 or 1)

uniform mat4 uViewProj;
uniform vec4 uOpts; // x=showRapids, y=showCuts, z=isLight, w=passMode (0=segs, 1=box, 2=wcs)
uniform vec4 uStockMin;
uniform vec4 uStockMax;
uniform vec4 uWcsOrigin;

out vec4 vColor;

vec3 stockCorner(int idx) {
  float x = (idx & 1) != 0 ? uStockMax.x : uStockMin.x;
  float y = (idx & 2) != 0 ? uStockMax.y : uStockMin.y;
  float z = (idx & 4) != 0 ? uStockMax.z : uStockMin.z;
  return vec3(x, y, z);
}

void finishLinePos(vec3 wp) {
  vec4 cp = uViewProj * vec4(wp, 1.0);
  cp.z = cp.z * 2.0 - cp.w;
  gl_Position = cp;
}

void main() {
  int vid = gl_VertexID;
  bool isLight = uOpts.z > 0.5;

  if (uOpts.w > 1.5) {
    float span = max(uStockMax.x - uStockMin.x, uStockMax.y - uStockMin.y);
    float axisLen = clamp(span * 0.22, 10.0, 38.0);
    int axisId = (vid / 2) % 3;
    bool isTip = (vid % 2) == 1;
    vec3 wp = uWcsOrigin.xyz + vec3(0.0, 0.0, 0.08);
    vec4 col = vec4(0.94, 0.26, 0.26, 0.95);
    if (axisId == 0) {
      if (isTip) wp.x += axisLen;
      col = vec4(0.94, 0.26, 0.26, 0.95);
    } else if (axisId == 1) {
      if (isTip) wp.y += axisLen;
      col = vec4(0.13, 0.76, 0.42, 0.95);
    } else {
      if (isTip) wp.z += axisLen;
      col = vec4(0.23, 0.52, 0.96, 0.95);
    }
    vColor = col;
    finishLinePos(wp);
    return;
  }

  if (uOpts.w > 0.5) {
    int edges[24] = int[24](
      0, 1,  1, 3,  3, 2,  2, 0,
      4, 5,  5, 7,  7, 6,  6, 4,
      0, 4,  1, 5,  2, 6,  3, 7
    );
    vec3 wp = stockCorner(edges[vid % 24]);
    vColor = isLight ? vec4(0.38, 0.42, 0.48, 0.58) : vec4(0.55, 0.58, 0.66, 0.52);
    finishLinePos(wp);
    return;
  }

  bool isCut = aSegVert.w > 0.5;
  if ((!isCut && uOpts.x < 0.5) || (isCut && uOpts.y < 0.5)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColor = vec4(0.0);
    return;
  }

  vec3 p = vec3(aSegVert.x, aSegVert.y, aSegVert.z + 0.06);
  finishLinePos(p);

  if (!isCut) {
    vColor = isLight ? vec4(0.88, 0.22, 0.18, 0.80) : vec4(1.0, 0.38, 0.30, 0.82);
  } else {
    float zSpan = max(uStockMax.z - uStockMin.z, 1.0);
    float depthT = clamp((uStockMax.z - p.z) / zSpan, 0.0, 1.0);
    if (isLight) {
      vColor = vec4(mix(vec3(0.03, 0.45, 0.85), vec3(0.05, 0.62, 0.48), depthT), 0.90);
    } else {
      vColor = vec4(mix(vec3(0.24, 0.76, 0.98), vec3(0.20, 0.90, 0.66), depthT), 0.88);
    }
  }
}
`;

const LINE_FS_GLSL = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 fragColor;
void main() {
  if (vColor.a <= 0.01) discard;
  fragColor = vColor;
}
`;

function compileGlProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string
): WebGLProgram {
  const vs = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vs, vsSrc);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(vs);
    gl.deleteShader(vs);
    throw new Error(`WebGL2 VS error: ${info}`);
  }
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fs, fsSrc);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error(`WebGL2 FS error: ${info}`);
  }
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`WebGL2 link error: ${info}`);
  }
  return prog;
}

function toolEnvelopeDz(
  r: number,
  toolKind: number,
  outerR: number,
  tipR: number,
  halfAngleRad: number
): number {
  if (r <= 1e-6) return 0.0;
  if (toolKind === 0) return 0.0;
  if (toolKind === 1) {
    return outerR - Math.sqrt(Math.max(outerR * outerR - r * r, 0.0));
  }
  if (toolKind === 3) {
    const cr = Math.min(Math.max(tipR, 0.0), outerR);
    const flatR = Math.max(outerR - cr, 0.0);
    if (r <= flatR || cr <= 1e-5) return 0.0;
    const dr = r - flatR;
    return cr - Math.sqrt(Math.max(cr * cr - dr * dr, 0.0));
  }
  // TaperedBallNose (2) & VBit (4)
  const rTip = Math.min(Math.max(tipR, 0.0), outerR);
  const alpha = Math.min(Math.max(halfAngleRad, 0.008), 1.48);
  const sinA = Math.sin(alpha);
  const cosA = Math.cos(alpha);
  const tanA = Math.tan(alpha);
  const rTan = rTip * cosA;
  const zTan = rTip * (1.0 - sinA);
  if (r <= rTan && rTip > 1e-5) {
    return rTip - Math.sqrt(Math.max(rTip * rTip - r * r, 0.0));
  }
  return zTan + (r - rTan) / tanA;
}

function carveSegmentsIntoGrid(
  segFloats: Float32Array,
  segUints: Uint32Array,
  startSeg: number,
  endSeg: number,
  stock: StockSpec,
  tool: ToolSpec,
  gw: number,
  gh: number,
  cellDx: number,
  cellDy: number,
  heightsI32: Int32Array,
  heightsF32: Float32Array
) {
  const sminX = stock.min[0];
  const sminY = stock.min[1];
  const sminZ = stock.min[2];
  const smaxX = stock.max[0];
  const smaxY = stock.max[1];
  const smaxZ = stock.max[2];
  const pierceFloor = sminZ - 0.25;

  const toolKind = TOOL_KIND_CODE[tool.kind] ?? 0;
  const outerR = Math.max(tool.diameter * 0.5, 0.05);
  const tipR = tool.tip_radius;
  const halfAngleRad = (tool.half_angle_deg * Math.PI) / 180.0;
  const r2 = outerR * outerR;

  for (let s = startSeg; s < endSeg; s++) {
    const base = s * 8;
    const x0 = segFloats[base];
    const y0 = segFloats[base + 1];
    const z0 = segFloats[base + 2];
    const kindAndTool = segUints[base + 3];
    const x1 = segFloats[base + 4];
    const y1 = segFloats[base + 5];
    const z1 = segFloats[base + 6];

    const isCut = (kindAndTool & 0xff) !== 0;
    if (!isCut && Math.min(z0, z1) >= smaxZ) continue;

    const minX = Math.min(x0, x1) - outerR;
    const maxX = Math.max(x0, x1) + outerR;
    const minY = Math.min(y0, y1) - outerR;
    const maxY = Math.max(y0, y1) + outerR;
    if (maxX < sminX || minX > smaxX || maxY < sminY || minY > smaxY) continue;

    const ix0 = Math.min(Math.max(Math.floor((minX - sminX) / cellDx), 0), gw - 1);
    const ix1 = Math.min(Math.max(Math.ceil((maxX - sminX) / cellDx), 0), gw - 1);
    const iy0 = Math.min(Math.max(Math.floor((minY - sminY) / cellDy), 0), gh - 1);
    const iy1 = Math.min(Math.max(Math.ceil((maxY - sminY) / cellDy), 0), gh - 1);

    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const len2 = dx * dx + dy * dy;

    for (let iy = iy0; iy <= iy1; iy++) {
      const qy = sminY + iy * cellDy;
      const rowOff = iy * gw;

      for (let ix = ix0; ix <= ix1; ix++) {
        const qx = sminX + ix * cellDx;
        let bestZ = 1e9;

        if (len2 < 1e-8) {
          const vx = qx - x0;
          const vy = qy - y0;
          const d2 = vx * vx + vy * vy;
          if (d2 > r2) continue;
          bestZ =
            Math.min(z0, z1) +
            toolEnvelopeDz(Math.sqrt(d2), toolKind, outerR, tipR, halfAngleRad);
        } else {
          const vx = qx - x0;
          const vy = qy - y0;
          const tFree = (vx * dx + vy * dy) / len2;
          const tPerp = Math.min(Math.max(tFree, 0.0), 1.0);
          const rx = qx - (x0 + tPerp * dx);
          const ry = qy - (y0 + tPerp * dy);
          const d2Min = rx * rx + ry * ry;
          if (d2Min > r2) continue;

          if (Math.abs(dz) < 1e-5) {
            bestZ =
              z0 +
              toolEnvelopeDz(
                Math.sqrt(d2Min),
                toolKind,
                outerR,
                tipR,
                halfAngleRad
              );
          } else {
            const d2Line = Math.max(vx * vx + vy * vy - tFree * tFree * len2, 0.0);
            const dtMax = Math.sqrt(Math.max(r2 - d2Line, 0.0) / len2);
            let ta = Math.min(Math.max(tFree - dtMax, 0.0), 1.0);
            let tb = Math.min(Math.max(tFree + dtMax, 0.0), 1.0);

            if (toolKind === 0) {
              bestZ = Math.min(z0 + ta * dz, z0 + tb * dz);
            } else {
              const evalAt = (t: number) => {
                const cx = x0 + t * dx;
                const cy = y0 + t * dy;
                const cz = z0 + t * dz;
                return (
                  cz +
                  toolEnvelopeDz(
                    Math.hypot(qx - cx, qy - cy),
                    toolKind,
                    outerR,
                    tipR,
                    halfAngleRad
                  )
                );
              };
              bestZ = Math.min(
                evalAt(ta),
                evalAt(tb),
                evalAt(Math.min(Math.max(tFree, ta), tb))
              );
              for (let it = 0; it < 5; it++) {
                const m1 = ta + (tb - ta) * 0.381966;
                const m2 = ta + (tb - ta) * 0.618034;
                const zm1 = evalAt(m1);
                const zm2 = evalAt(m2);
                if (zm1 < zm2) {
                  if (zm1 < bestZ) bestZ = zm1;
                  tb = m2;
                } else {
                  if (zm2 < bestZ) bestZ = zm2;
                  ta = m1;
                }
              }
            }
          }
        }

        if (bestZ < smaxZ) {
          const zClamped = Math.max(bestZ, pierceFloor);
          const zInt = Math.round(zClamped * Z_SCALE);
          const cellIdx = rowOff + ix;
          if (zInt < heightsI32[cellIdx]) {
            heightsI32[cellIdx] = zInt;
            heightsF32[cellIdx] = zClamped;
          }
        }
      }
    }
  }
}

function computeCameraViewProj(
  cam: CameraState,
  stock: StockSpec,
  aspect: number
): { eye: [number, number, number]; vp: Float32Array } {
  const sx = stock.max[0] - stock.min[0];
  const sy = stock.max[1] - stock.min[1];
  const sz = stock.max[2] - stock.min[2];
  const center: [number, number, number] = [
    0.5 * (stock.min[0] + stock.max[0]) + cam.panX,
    0.5 * (stock.min[1] + stock.max[1]) + cam.panY,
    0.5 * (stock.min[2] + stock.max[2]) + cam.panZ,
  ];
  const radius = Math.max(Math.hypot(sx, sy, sz) * 0.5, 5.0);
  const fovY = (33.0 * Math.PI) / 180.0;
  const fitFactor = aspect < 1.0 ? 1.0 / aspect : 1.0;
  const dist =
    ((radius / Math.tan(fovY * 0.5)) * 1.18 * fitFactor) /
    Math.max(cam.zoom, 0.15);

  const yaw = (cam.yawDeg * Math.PI) / 180.0;
  const pitch =
    (Math.min(Math.max(cam.pitchDeg, -89.2), 89.2) * Math.PI) / 180.0;
  const isOrtho = Boolean(cam.ortho);
  const eyeDist = isOrtho ? Math.max(dist, radius * 16.0) : dist;
  const eye: [number, number, number] = [
    center[0] + eyeDist * Math.cos(pitch) * Math.sin(yaw),
    center[1] - eyeDist * Math.cos(pitch) * Math.cos(yaw),
    center[2] + eyeDist * Math.sin(pitch),
  ];
  const halfH = (radius * 1.18 * fitFactor) / Math.max(cam.zoom, 0.15);
  const proj = isOrtho
    ? orthoRhZeroToOne(halfH * aspect, halfH, 0.1, eyeDist * 3.0)
    : perspectiveRhZeroToOne(
        fovY,
        aspect,
        Math.max(dist * 0.02, 0.2),
        dist * 5.0
      );
  const view = lookAtRh(eye, center, [0, 0, 1]);
  return { eye, vp: mulMat4(proj, view) };
}

/**
 * Windows 7 (WebView2 109 / D3D11 ANGLE) & Legacy GPU WebGL 2.0 3D Studio Viewport Engine.
 */
export class WebGl2Viewport implements ViewportEngine {
  private canvas: HTMLCanvasElement;
  private gl!: WebGL2RenderingContext;

  private partProg!: WebGLProgram;
  private lineProg!: WebGLProgram;
  private emptyVao!: WebGLVertexArrayObject;
  private lineVao!: WebGLVertexArrayObject;
  private lineVbo!: WebGLBuffer;
  private heightTex!: WebGLTexture;

  private partLocs!: Record<string, WebGLUniformLocation | null>;
  private lineLocs!: Record<string, WebGLUniformLocation | null>;

  private segFloats: Float32Array = new Float32Array(0);
  private segUints: Uint32Array = new Uint32Array(0);
  private totalSegments = 0;

  private gridW = 0;
  private gridH = 0;
  private cellDx = 0.15;
  private cellDy = 0.15;
  private simulatedUpTo = -1;
  private lastSimSignature = "";
  private heightsI32: Int32Array = new Int32Array(0);
  private heightsF32: Float32Array = new Float32Array(0);

  private lastCutterWorldPos: [number, number, number] = [0, 0, 15];
  private lastStock: StockSpec = {
    min: [-42, -42, -14],
    max: [42, 42, 0],
    inferred: true,
  };
  private lastViewProj: Float32Array = new Float32Array(16);
  private lastInvViewProj: Float32Array | null = null;
  private lastRenderedViews: Array<{
    cssX: number;
    cssY: number;
    cssW: number;
    cssH: number;
    viewProj: Float32Array;
    invViewProj: Float32Array | null;
  }> = [];
  private lastSectionAxis: 0 | 1 | 2 = 0;
  private lastSectionPos = 0;

  private thumbCanvas: HTMLCanvasElement | null = null;
  private thumbGl: WebGL2RenderingContext | null = null;
  private thumbPartProg: WebGLProgram | null = null;
  private thumbVao: WebGLVertexArrayObject | null = null;
  private thumbHeightTex: WebGLTexture | null = null;
  private thumbQueue: Promise<void> = Promise.resolve();

  private constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  static async create(
    canvas: HTMLCanvasElement,
    _onAsyncUpdate?: () => void,
    isDisposed?: () => boolean
  ): Promise<WebGl2Viewport> {
    if (isDisposed?.()) {
      throw new Error("WebGL2 init cancelled");
    }
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: true,
      depth: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    if (!gl) {
      throw new Error("WebGL2 is not supported on this graphics driver");
    }

    const vp = new WebGl2Viewport(canvas);
    vp.gl = gl;
    vp.initResources();
    return vp;
  }

  private initResources() {
    const gl = this.gl;
    this.partProg = compileGlProgram(gl, PART_VS_GLSL, PART_FS_GLSL);
    this.lineProg = compileGlProgram(gl, LINE_VS_GLSL, LINE_FS_GLSL);

    this.partLocs = {
      uViewProj: gl.getUniformLocation(this.partProg, "uViewProj"),
      uCameraPos: gl.getUniformLocation(this.partProg, "uCameraPos"),
      uStockMin: gl.getUniformLocation(this.partProg, "uStockMin"),
      uStockMax: gl.getUniformLocation(this.partProg, "uStockMax"),
      uGridInfo: gl.getUniformLocation(this.partProg, "uGridInfo"),
      uStyleInfo: gl.getUniformLocation(this.partProg, "uStyleInfo"),
      uCutterPos: gl.getUniformLocation(this.partProg, "uCutterPos"),
      uCutterGeom: gl.getUniformLocation(this.partProg, "uCutterGeom"),
      uSectionInfo: gl.getUniformLocation(this.partProg, "uSectionInfo"),
      uHeightTex: gl.getUniformLocation(this.partProg, "uHeightTex"),
    };

    this.lineLocs = {
      uViewProj: gl.getUniformLocation(this.lineProg, "uViewProj"),
      uOpts: gl.getUniformLocation(this.lineProg, "uOpts"),
      uStockMin: gl.getUniformLocation(this.lineProg, "uStockMin"),
      uStockMax: gl.getUniformLocation(this.lineProg, "uStockMax"),
      uWcsOrigin: gl.getUniformLocation(this.lineProg, "uWcsOrigin"),
    };

    this.emptyVao = gl.createVertexArray()!;
    this.lineVao = gl.createVertexArray()!;
    this.lineVbo = gl.createBuffer()!;

    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.bindVertexArray(null);

    this.heightTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.uploadSegments(new ArrayBuffer(32));
  }

  setOnAsyncUpdate(_cb: (() => void) | null) {
    // Synchronous incremental updates in WebGL2 mode
  }

  getActivePrecisionInfo(): { mmPerCell: number; isRoi: boolean; subdiv: number } {
    return {
      mmPerCell: Math.min(this.cellDx, this.cellDy),
      isRoi: false,
      subdiv: 1,
    };
  }

  uploadSegments(rawBuffer: ArrayBuffer) {
    const alignedBuf =
      rawBuffer.byteLength >= 32 ? rawBuffer : new ArrayBuffer(32);
    this.totalSegments = Math.floor(rawBuffer.byteLength / 32);
    this.segFloats = new Float32Array(alignedBuf);
    this.segUints = new Uint32Array(alignedBuf);

    // Pack 2 vertices per segment [x, y, z, isCut] for fast gl.LINES draw
    const count = Math.max(this.totalSegments, 1);
    const lineVerts = new Float32Array(count * 8);
    for (let i = 0; i < this.totalSegments; i++) {
      const sb = i * 8;
      const vb = i * 8;
      const isCut = (this.segUints[sb + 3] & 0xff) !== 0 ? 1.0 : 0.0;
      lineVerts[vb] = this.segFloats[sb];
      lineVerts[vb + 1] = this.segFloats[sb + 1];
      lineVerts[vb + 2] = this.segFloats[sb + 2];
      lineVerts[vb + 3] = isCut;
      lineVerts[vb + 4] = this.segFloats[sb + 4];
      lineVerts[vb + 5] = this.segFloats[sb + 5];
      lineVerts[vb + 6] = this.segFloats[sb + 6];
      lineVerts[vb + 7] = isCut;
    }

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, lineVerts, gl.STATIC_DRAW);

    this.simulatedUpTo = -1;
    this.lastSimSignature = "";
  }

  getCurrentCutterPos(): [number, number, number] {
    return [...this.lastCutterWorldPos];
  }

  getSegmentTip(activeCount: number): SegmentTipInfo | null {
    if (this.totalSegments === 0) return null;
    if (activeCount <= 0) {
      const kind0 = this.segUints[3];
      return {
        x: this.segFloats[0],
        y: this.segFloats[1],
        z: this.segFloats[2],
        lineNumber: Math.max(1, this.segUints[7]),
        isCut: (kind0 & 0xff) !== 0,
        feedrate: (kind0 >>> 16) * 2.0,
      };
    }
    const idx = Math.min(activeCount - 1, this.totalSegments - 1);
    const base = idx * 8;
    const kindAndTool = this.segUints[base + 3];
    return {
      x: this.segFloats[base + 4],
      y: this.segFloats[base + 5],
      z: this.segFloats[base + 6],
      lineNumber: this.segUints[base + 7],
      isCut: (kindAndTool & 0xff) !== 0,
      feedrate: (kindAndTool >>> 16) * 2.0,
    };
  }

  findSegmentIndexForLine(lineNumber: number): number {
    if (this.totalSegments === 0) return 0;
    let lo = 0;
    let hi = this.totalSegments - 1;
    let ans = this.totalSegments;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const ln = this.segUints[mid * 8 + 7];
      if (ln >= lineNumber) {
        ans = mid + 1;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return Math.min(Math.max(ans, 1), this.totalSegments);
  }

  private updateSimulationIfNeeded(p: ViewportRenderParams) {
    const sx = Math.max(p.stock.max[0] - p.stock.min[0], 0.5);
    const sy = Math.max(p.stock.max[1] - p.stock.min[1], 0.5);
    // Tuned Win7 CPU-carve resolution tiers: Fast=360, HD=540, Ultra=768
    const maxDim =
      p.gridMaxDim <= 512 ? 360 : p.gridMaxDim <= 1024 ? 540 : 768;
    const scale = maxDim / Math.max(sx, sy);
    const gw = Math.min(Math.max(Math.round(sx * scale), 64), 768);
    const gh = Math.min(Math.max(Math.round(sy * scale), 64), 768);
    const cellDx = sx / (gw - 1);
    const cellDy = sy / (gh - 1);

    const sig = [
      gw,
      gh,
      p.stock.min.join(","),
      p.stock.max.join(","),
      p.tool.kind,
      p.tool.diameter.toFixed(4),
      p.tool.tip_radius.toFixed(4),
      p.tool.half_angle_deg.toFixed(4),
    ].join("|");

    const targetSegs = Math.min(Math.max(p.activeSegments, 0), this.totalSegments);
    const gridRecreated =
      gw !== this.gridW ||
      gh !== this.gridH ||
      this.heightsI32.length !== gw * gh;

    if (gridRecreated) {
      this.gridW = gw;
      this.gridH = gh;
      this.heightsI32 = new Int32Array(gw * gh);
      this.heightsF32 = new Float32Array(gw * gh);
    }
    this.cellDx = cellDx;
    this.cellDy = cellDy;

    const fullReset =
      gridRecreated ||
      sig !== this.lastSimSignature ||
      targetSegs < this.simulatedUpTo;

    if (!fullReset && targetSegs === this.simulatedUpTo) {
      return;
    }

    if (fullReset) {
      const zInit = Math.round(p.stock.max[2] * Z_SCALE);
      this.heightsI32.fill(zInit);
      this.heightsF32.fill(p.stock.max[2]);
    }

    const startOffset = fullReset ? 0 : Math.max(this.simulatedUpTo, 0);
    if (targetSegs > startOffset) {
      carveSegmentsIntoGrid(
        this.segFloats,
        this.segUints,
        startOffset,
        targetSegs,
        p.stock,
        p.tool,
        gw,
        gh,
        cellDx,
        cellDy,
        this.heightsI32,
        this.heightsF32
      );
    }

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      gw,
      gh,
      0,
      gl.RED,
      gl.FLOAT,
      this.heightsF32
    );

    this.lastSimSignature = sig;
    this.simulatedUpTo = targetSegs;
  }

  render(p: ViewportRenderParams) {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(this.canvas.clientWidth, 1);
    const cssH = Math.max(this.canvas.clientHeight, 1);
    const physW = Math.max(Math.round(cssW * dpr), 4);
    const physH = Math.max(Math.round(cssH * dpr), 4);
    if (this.canvas.width !== physW || this.canvas.height !== physH) {
      this.canvas.width = physW;
      this.canvas.height = physH;
    }

    this.lastStock = {
      min: [...p.stock.min] as [number, number, number],
      max: [...p.stock.max] as [number, number, number],
      inferred: p.stock.inferred,
    };

    if (p.showSolid) {
      this.updateSimulationIfNeeded(p);
    }

    const tip = this.getSegmentTip(p.activeSegments);
    const cutterPos: [number, number, number] = p.cutterOverride
      ? p.cutterOverride
      : tip
      ? [tip.x, tip.y, tip.z]
      : [0, 0, p.stock.max[2] + 10];
    this.lastCutterWorldPos = cutterPos;

    const secAxis: 0 | 1 | 2 = p.sectionAxis ?? 0;
    const secRatio = Math.min(Math.max(p.sectionRatio ?? 0.5, 0.0), 1.0);
    const secPos =
      secAxis === 1
        ? p.stock.min[0] + secRatio * (p.stock.max[0] - p.stock.min[0])
        : secAxis === 2
        ? p.stock.min[1] + secRatio * (p.stock.max[1] - p.stock.min[1])
        : 0.0;
    this.lastSectionAxis = secAxis;
    this.lastSectionPos = secPos;

    const subList =
      p.subViewports && p.subViewports.length > 0
        ? p.subViewports
        : [{ rect: [0, 0, 1, 1] as [number, number, number, number], camera: p.camera }];

    if (p.darkMode) {
      gl.clearColor(0.036, 0.036, 0.044, 1.0);
    } else {
      gl.clearColor(0.958, 0.961, 0.969, 1.0);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA
    );

    const wcs = p.wcsOrigin ?? [0, 0, p.stock.max[2]];
    const topVerts = Math.max((this.gridW - 1) * (this.gridH - 1) * 6, 0);
    const skirtVerts = Math.max(2 * (this.gridW - 1 + (this.gridH - 1)) * 6, 0);
    const activeDraw = Math.min(Math.max(p.activeSegments, 0), this.totalSegments);

    this.lastRenderedViews = [];

    for (let vIdx = 0; vIdx < subList.length; vIdx++) {
      const sv = subList[vIdx];
      const [rx, ry, rw, rh] = sv.rect;
      const px0 = Math.round(rx * physW);
      const py0 = Math.round(ry * physH);
      const vpW = Math.max(Math.round(rw * physW), 2);
      const vpH = Math.max(Math.round(rh * physH), 2);
      const glY = Math.max(physH - (py0 + vpH), 0);

      gl.viewport(px0, glY, vpW, vpH);
      gl.scissor(px0, glY, vpW, vpH);

      const { eye, vp } = computeCameraViewProj(sv.camera, p.stock, vpW / vpH);
      const invVp = invertMat4(vp);
      if (vIdx === 0) {
        this.lastViewProj = vp;
        this.lastInvViewProj = invVp;
      }
      this.lastRenderedViews.push({
        cssX: rx * cssW,
        cssY: ry * cssH,
        cssW: rw * cssW,
        cssH: rh * cssH,
        viewProj: vp,
        invViewProj: invVp,
      });

      // Part & Floor Shader
      gl.useProgram(this.partProg);
      gl.bindVertexArray(this.emptyVao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
      gl.uniform1i(this.partLocs.uHeightTex, 0);
      gl.uniformMatrix4fv(this.partLocs.uViewProj, false, vp);
      gl.uniform4f(this.partLocs.uCameraPos, eye[0], eye[1], eye[2], 1.0);
      gl.uniform4f(
        this.partLocs.uStockMin,
        p.stock.min[0],
        p.stock.min[1],
        p.stock.min[2],
        p.darkMode ? 0.0 : 1.0
      );
      gl.uniform4f(
        this.partLocs.uStockMax,
        p.stock.max[0],
        p.stock.max[1],
        p.stock.max[2],
        0.0
      );
      gl.uniform4f(
        this.partLocs.uGridInfo,
        Math.max(this.gridW, 2),
        Math.max(this.gridH, 2),
        this.cellDx,
        this.cellDy
      );
      gl.uniform4f(
        this.partLocs.uCutterPos,
        cutterPos[0],
        cutterPos[1],
        cutterPos[2],
        Math.max(p.tool.diameter * 0.5, 0.2)
      );
      gl.uniform4f(
        this.partLocs.uCutterGeom,
        TOOL_KIND_CODE[p.tool.kind] ?? 0,
        p.tool.tip_radius,
        (p.tool.half_angle_deg * Math.PI) / 180.0,
        p.tool.flute_length || Math.max(p.tool.diameter * 5.0, 16.0)
      );
      gl.uniform4f(this.partLocs.uSectionInfo, secAxis, secPos, 0.0, 1.0);

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);

      if (p.showFloor) {
        gl.uniform4f(this.partLocs.uStyleInfo, p.materialId, 4.0, 1.0, 0.0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }

      if (p.showSolid && topVerts > 0) {
        gl.uniform4f(this.partLocs.uStyleInfo, p.materialId, 0.0, 1.0, 0.0);
        gl.drawArrays(gl.TRIANGLES, 0, topVerts);

        gl.uniform4f(this.partLocs.uStyleInfo, p.materialId, 1.0, 1.0, 0.0);
        gl.drawArrays(gl.TRIANGLES, 0, skirtVerts);

        gl.uniform4f(this.partLocs.uStyleInfo, p.materialId, 2.0, 1.0, 0.0);
        gl.drawArrays(gl.TRIANGLES, 0, topVerts);

        if (secAxis > 0 && secRatio > 0.002 && secRatio < 0.998) {
          const secSegs = secAxis === 1 ? this.gridH - 1 : this.gridW - 1;
          gl.uniform4f(this.partLocs.uStyleInfo, p.materialId, 5.0, 1.0, 0.0);
          gl.drawArrays(gl.TRIANGLES, 0, secSegs * 6);
        }
      }

      if (p.showCutter && this.totalSegments > 0 && p.activeSegments > 0) {
        gl.uniform4f(this.partLocs.uStyleInfo, p.materialId, 3.0, 1.0, 0.0);
        gl.drawArrays(gl.TRIANGLES, 0, 32 * 24 * 6);
      }

      // Lines (WCS Triad + Stock Box + G0/G1 Toolpath)
      gl.useProgram(this.lineProg);
      gl.depthMask(false);
      gl.uniformMatrix4fv(this.lineLocs.uViewProj, false, vp);
      gl.uniform4f(
        this.lineLocs.uStockMin,
        p.stock.min[0],
        p.stock.min[1],
        p.stock.min[2],
        0.0
      );
      gl.uniform4f(
        this.lineLocs.uStockMax,
        p.stock.max[0],
        p.stock.max[1],
        p.stock.max[2],
        0.0
      );
      gl.uniform4f(this.lineLocs.uWcsOrigin, wcs[0], wcs[1], wcs[2], 0.0);

      const lightFlag = p.darkMode ? 0.0 : 1.0;
      if (p.showFloor) {
        gl.bindVertexArray(this.emptyVao);
        gl.uniform4f(this.lineLocs.uOpts, 0.0, 0.0, lightFlag, 2.0);
        gl.drawArrays(gl.LINES, 0, 6);
      }
      if (p.showStockBox) {
        gl.bindVertexArray(this.emptyVao);
        gl.uniform4f(this.lineLocs.uOpts, 0.0, 0.0, lightFlag, 1.0);
        gl.drawArrays(gl.LINES, 0, 24);
      }
      if ((p.showCutsOverlay || p.showRapidsOverlay) && activeDraw > 0) {
        gl.bindVertexArray(this.lineVao);
        gl.uniform4f(
          this.lineLocs.uOpts,
          p.showRapidsOverlay ? 1.0 : 0.0,
          p.showCutsOverlay ? 1.0 : 0.0,
          lightFlag,
          0.0
        );
        gl.drawArrays(gl.LINES, 0, activeDraw * 2);
      }
      gl.depthMask(true);
    }

    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
  }

  private sampleRawZ(wx: number, wy: number): number {
    if (this.heightsI32.length !== this.gridW * this.gridH || this.gridW < 2) {
      return this.lastStock.max[2];
    }
    const fx = Math.min(
      Math.max((wx - this.lastStock.min[0]) / this.cellDx, 0),
      this.gridW - 1.0001
    );
    const fy = Math.min(
      Math.max((wy - this.lastStock.min[1]) / this.cellDy, 0),
      this.gridH - 1.0001
    );
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const gw = this.gridW;
    const z00 = this.heightsI32[iy * gw + ix] / Z_SCALE;
    const z10 = this.heightsI32[iy * gw + ix + 1] / Z_SCALE;
    const z01 = this.heightsI32[(iy + 1) * gw + ix] / Z_SCALE;
    const z11 = this.heightsI32[(iy + 1) * gw + ix + 1] / Z_SCALE;
    return (z00 + (z10 - z00) * tx) * (1 - ty) + (z01 + (z11 - z01) * tx) * ty;
  }

  pickModelPoint(
    localCssX: number,
    localCssY: number,
    showSolid: boolean,
    activeSegments: number
  ): [number, number, number] | null {
    const cw = Math.max(this.canvas.clientWidth, 1);
    const ch = Math.max(this.canvas.clientHeight, 1);
    let viewEntry = this.lastRenderedViews.find(
      (v) =>
        localCssX >= v.cssX &&
        localCssX <= v.cssX + v.cssW &&
        localCssY >= v.cssY &&
        localCssY <= v.cssY + v.cssH
    );
    if (!viewEntry && this.lastInvViewProj) {
      viewEntry = {
        cssX: 0,
        cssY: 0,
        cssW: cw,
        cssH: ch,
        viewProj: this.lastViewProj,
        invViewProj: this.lastInvViewProj,
      };
    }
    if (!viewEntry || !viewEntry.invViewProj) return null;

    const subLocalX = localCssX - viewEntry.cssX;
    const subLocalY = localCssY - viewEntry.cssY;
    const subW = Math.max(viewEntry.cssW, 1);
    const subH = Math.max(viewEntry.cssH, 1);
    const ndcX = (subLocalX / subW) * 2.0 - 1.0;
    const ndcY = 1.0 - (subLocalY / subH) * 2.0;

    if (showSolid && this.heightsI32.length === this.gridW * this.gridH && this.gridW >= 2) {
      const pNear = unprojectPoint(viewEntry.invViewProj, ndcX, ndcY, 0.0);
      const pFar = unprojectPoint(viewEntry.invViewProj, ndcX, ndcY, 1.0);
      let dx = pFar[0] - pNear[0];
      let dy = pFar[1] - pNear[1];
      let dz = pFar[2] - pNear[2];
      const len = Math.hypot(dx, dy, dz) || 1.0;
      dx /= len;
      dy /= len;
      dz /= len;

      const smin: [number, number, number] = [
        this.lastSectionAxis === 1
          ? Math.max(this.lastStock.min[0], this.lastSectionPos)
          : this.lastStock.min[0],
        this.lastSectionAxis === 2
          ? Math.max(this.lastStock.min[1], this.lastSectionPos)
          : this.lastStock.min[1],
        this.lastStock.min[2],
      ];
      const smax = this.lastStock.max;

      let tMin = 0.0;
      let tMax = len;
      const orig = pNear;
      const dir = [dx, dy, dz];
      for (let a = 0; a < 3; a++) {
        if (Math.abs(dir[a]) < 1e-8) {
          if (orig[a] < smin[a] || orig[a] > smax[a]) return null;
        } else {
          const invD = 1.0 / dir[a];
          let t1 = (smin[a] - orig[a]) * invD;
          let t2 = (smax[a] - orig[a]) * invD;
          if (t1 > t2) {
            const tmp = t1;
            t1 = t2;
            t2 = tmp;
          }
          tMin = Math.max(tMin, t1);
          tMax = Math.min(tMax, t2);
          if (tMin > tMax) return null;
        }
      }

      const step = Math.max(Math.min(this.cellDx, this.cellDy) * 0.5, 0.05);
      let prevT = tMin;
      let prevDiff = 1.0;
      for (let t = tMin; t <= tMax; t += step) {
        const px = orig[0] + dx * t;
        const py = orig[1] + dy * t;
        const pz = orig[2] + dz * t;
        const rawZ = this.sampleRawZ(px, py);
        if (rawZ < smin[2] - 0.03) continue;
        const surfZ = Math.min(Math.max(rawZ, smin[2]), smax[2]);
        const diff = pz - surfZ;
        if (diff <= 0.0) {
          const frac = prevDiff / Math.max(prevDiff - diff, 1e-6);
          const hitT = prevT + (t - prevT) * Math.min(Math.max(frac, 0.0), 1.0);
          const hx = orig[0] + dx * hitT;
          const hy = orig[1] + dy * hitT;
          const hz = Math.min(
            Math.max(this.sampleRawZ(hx, hy), smin[2]),
            smax[2]
          );
          return [hx, hy, hz];
        }
        prevT = t;
        prevDiff = diff;
      }
    }

    // Fallback: nearest visible toolpath vertex
    const limit = Math.min(Math.max(activeSegments, 0), this.totalSegments);
    let bestPt: [number, number, number] | null = null;
    let bestD2 = 18 * 18;
    for (let i = 0; i < limit; i++) {
      const b = i * 8;
      const pt: [number, number, number] = [
        this.segFloats[b + 4],
        this.segFloats[b + 5],
        this.segFloats[b + 6],
      ];
      const sp = projectPointToCss(viewEntry.viewProj, pt, subW, subH);
      if (!sp.visible) continue;
      const d2 = (sp.x - subLocalX) ** 2 + (sp.y - subLocalY) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestPt = pt;
      }
    }
    return bestPt;
  }

  async exportBinaryStl(): Promise<{ buffer: ArrayBuffer; triCount: number }> {
    const gw = this.gridW;
    const gh = this.gridH;
    if (gw < 2 || gh < 2 || this.heightsI32.length !== gw * gh) {
      throw new Error("No valid 3D heightfield available for STL export");
    }
    const heightsI32 = this.heightsI32;
    const smin = this.lastStock.min;
    const smax = this.lastStock.max;
    const dx = this.cellDx;
    const dy = this.cellDy;
    const cellsX = gw - 1;
    const cellsY = gh - 1;
    const pierceZ = smin[2] - 0.03;

    const solid = new Uint8Array(cellsX * cellsY);
    for (let qy = 0; qy < cellsY; qy++) {
      for (let qx = 0; qx < cellsX; qx++) {
        const r00 = heightsI32[qy * gw + qx] / Z_SCALE;
        const r10 = heightsI32[qy * gw + qx + 1] / Z_SCALE;
        const r01 = heightsI32[(qy + 1) * gw + qx] / Z_SCALE;
        const r11 = heightsI32[(qy + 1) * gw + qx + 1] / Z_SCALE;
        solid[qy * cellsX + qx] =
          r00 < pierceZ && r10 < pierceZ && r01 < pierceZ && r11 < pierceZ
            ? 0
            : 1;
      }
    }
    const isSolid = (qx: number, qy: number) =>
      qx >= 0 && qy >= 0 && qx < cellsX && qy < cellsY && solid[qy * cellsX + qx] === 1;

    let triCount = 0;
    for (let qy = 0; qy < cellsY; qy++) {
      for (let qx = 0; qx < cellsX; qx++) {
        if (!solid[qy * cellsX + qx]) continue;
        triCount += 4;
        if (!isSolid(qx, qy - 1)) triCount += 2;
        if (!isSolid(qx, qy + 1)) triCount += 2;
        if (!isSolid(qx - 1, qy)) triCount += 2;
        if (!isSolid(qx + 1, qy)) triCount += 2;
      }
    }

    const outBuf = new ArrayBuffer(84 + triCount * 50);
    const u8 = new Uint8Array(outBuf);
    const title = "ShibaNC Watertight 3-Axis Machined Mesh (Units: mm)";
    for (let i = 0; i < title.length; i++) u8[i] = title.charCodeAt(i);
    const dv = new DataView(outBuf);
    dv.setUint32(80, triCount, true);

    let offset = 84;
    const writeTri = (
      ax: number,
      ay: number,
      az: number,
      bx: number,
      by: number,
      bz: number,
      cx: number,
      cy: number,
      cz: number
    ) => {
      const ux = bx - ax,
        uy = by - ay,
        uz = bz - az;
      const vx = cx - ax,
        vy = cy - ay,
        vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1.0;
      dv.setFloat32(offset, nx / nl, true);
      dv.setFloat32(offset + 4, ny / nl, true);
      dv.setFloat32(offset + 8, nz / nl, true);
      dv.setFloat32(offset + 12, ax, true);
      dv.setFloat32(offset + 16, ay, true);
      dv.setFloat32(offset + 20, az, true);
      dv.setFloat32(offset + 24, bx, true);
      dv.setFloat32(offset + 28, by, true);
      dv.setFloat32(offset + 32, bz, true);
      dv.setFloat32(offset + 36, cx, true);
      dv.setFloat32(offset + 40, cy, true);
      dv.setFloat32(offset + 44, cz, true);
      dv.setUint16(offset + 48, 0, true);
      offset += 50;
    };

    const clampedZ = (ix: number, iy: number) =>
      Math.min(Math.max(heightsI32[iy * gw + ix] / Z_SCALE, smin[2]), smax[2]);
    const zBot = smin[2];

    for (let qy = 0; qy < cellsY; qy++) {
      const y0 = smin[1] + qy * dy;
      const y1 = y0 + dy;
      for (let qx = 0; qx < cellsX; qx++) {
        if (!solid[qy * cellsX + qx]) continue;
        const x0 = smin[0] + qx * dx;
        const x1 = x0 + dx;
        const z00 = clampedZ(qx, qy);
        const z10 = clampedZ(qx + 1, qy);
        const z01 = clampedZ(qx, qy + 1);
        const z11 = clampedZ(qx + 1, qy + 1);
        if (Math.abs(z11 - z00) <= Math.abs(z10 - z01)) {
          writeTri(x0, y0, z00, x1, y0, z10, x1, y1, z11);
          writeTri(x0, y0, z00, x1, y1, z11, x0, y1, z01);
        } else {
          writeTri(x0, y0, z00, x1, y0, z10, x0, y1, z01);
          writeTri(x1, y0, z10, x1, y1, z11, x0, y1, z01);
        }
        writeTri(x0, y0, zBot, x1, y1, zBot, x1, y0, zBot);
        writeTri(x0, y0, zBot, x0, y1, zBot, x1, y1, zBot);
        if (!isSolid(qx, qy - 1)) {
          writeTri(x0, y0, zBot, x1, y0, zBot, x1, y0, z10);
          writeTri(x0, y0, zBot, x1, y0, z10, x0, y0, z00);
        }
        if (!isSolid(qx, qy + 1)) {
          writeTri(x1, y1, zBot, x0, y1, zBot, x0, y1, z01);
          writeTri(x1, y1, zBot, x0, y1, z01, x1, y1, z11);
        }
        if (!isSolid(qx - 1, qy)) {
          writeTri(x0, y1, zBot, x0, y0, zBot, x0, y0, z00);
          writeTri(x0, y1, zBot, x0, y0, z00, x0, y1, z01);
        }
        if (!isSolid(qx + 1, qy)) {
          writeTri(x1, y0, zBot, x1, y1, zBot, x1, y1, z11);
          writeTri(x1, y0, zBot, x1, y1, z11, x1, y0, z10);
        }
      }
    }
    return { buffer: outBuf, triCount };
  }

  renderThumbnailDataUrl(
    segmentsBuffer: ArrayBuffer,
    stock: StockSpec,
    tool: ToolSpec,
    materialId: number,
    darkMode: boolean
  ): Promise<string> {
    const job = this.thumbQueue.then(
      () =>
        new Promise<string>((resolve) => {
          requestAnimationFrame(() => {
            try {
              resolve(
                this.renderThumbnailSync(
                  segmentsBuffer,
                  stock,
                  tool,
                  materialId,
                  darkMode
                )
              );
            } catch {
              resolve("");
            }
          });
        })
    );
    this.thumbQueue = job.then(
      () => undefined,
      () => undefined
    );
    return job;
  }

  private renderThumbnailSync(
    segmentsBuffer: ArrayBuffer,
    stock: StockSpec,
    tool: ToolSpec,
    materialId: number,
    darkMode: boolean
  ): string {
    const tw = 320;
    const th = 200;
    if (!this.thumbCanvas || !this.thumbGl || !this.thumbPartProg || !this.thumbVao || !this.thumbHeightTex) {
      const cvs = document.createElement("canvas");
      cvs.width = tw;
      cvs.height = th;
      const tgl = cvs.getContext("webgl2", {
        alpha: false,
        antialias: true,
        depth: true,
        preserveDrawingBuffer: true,
      });
      if (!tgl) return "";
      this.thumbCanvas = cvs;
      this.thumbGl = tgl;
      this.thumbPartProg = compileGlProgram(tgl, PART_VS_GLSL, PART_FS_GLSL);
      this.thumbVao = tgl.createVertexArray()!;
      this.thumbHeightTex = tgl.createTexture()!;
      tgl.bindTexture(tgl.TEXTURE_2D, this.thumbHeightTex);
      tgl.texParameteri(tgl.TEXTURE_2D, tgl.TEXTURE_MIN_FILTER, tgl.NEAREST);
      tgl.texParameteri(tgl.TEXTURE_2D, tgl.TEXTURE_MAG_FILTER, tgl.NEAREST);
      tgl.texParameteri(tgl.TEXTURE_2D, tgl.TEXTURE_WRAP_S, tgl.CLAMP_TO_EDGE);
      tgl.texParameteri(tgl.TEXTURE_2D, tgl.TEXTURE_WRAP_T, tgl.CLAMP_TO_EDGE);
    }

    const tgl = this.thumbGl;
    const prog = this.thumbPartProg;
    const aligned =
      segmentsBuffer.byteLength >= 32 ? segmentsBuffer : new ArrayBuffer(32);
    const totalSegs = Math.floor(segmentsBuffer.byteLength / 32);
    const sf = new Float32Array(aligned);
    const su = new Uint32Array(aligned);

    const sx = Math.max(stock.max[0] - stock.min[0], 0.5);
    const sy = Math.max(stock.max[1] - stock.min[1], 0.5);
    const scale = 200 / Math.max(sx, sy);
    const gw = Math.min(Math.max(Math.round(sx * scale), 64), 224);
    const gh = Math.min(Math.max(Math.round(sy * scale), 64), 224);
    const cellDx = sx / (gw - 1);
    const cellDy = sy / (gh - 1);

    const hI32 = new Int32Array(gw * gh).fill(Math.round(stock.max[2] * Z_SCALE));
    const hF32 = new Float32Array(gw * gh).fill(stock.max[2]);
    carveSegmentsIntoGrid(sf, su, 0, totalSegs, stock, tool, gw, gh, cellDx, cellDy, hI32, hF32);

    tgl.bindTexture(tgl.TEXTURE_2D, this.thumbHeightTex);
    tgl.pixelStorei(tgl.UNPACK_ALIGNMENT, 1);
    tgl.texImage2D(tgl.TEXTURE_2D, 0, tgl.R32F, gw, gh, 0, tgl.RED, tgl.FLOAT, hF32);

    tgl.viewport(0, 0, tw, th);
    if (darkMode) tgl.clearColor(0.055, 0.055, 0.065, 1.0);
    else tgl.clearColor(0.955, 0.958, 0.966, 1.0);
    tgl.clearDepth(1.0);
    tgl.clear(tgl.COLOR_BUFFER_BIT | tgl.DEPTH_BUFFER_BIT);
    tgl.enable(tgl.DEPTH_TEST);
    tgl.depthFunc(tgl.LEQUAL);

    const cam: CameraState = {
      yawDeg: -35,
      pitchDeg: 48,
      zoom: 1.12,
      panX: 0,
      panY: 0,
      panZ: 0,
      ortho: false,
    };
    const { eye, vp } = computeCameraViewProj(cam, stock, tw / th);

    tgl.useProgram(prog);
    tgl.bindVertexArray(this.thumbVao);
    tgl.activeTexture(tgl.TEXTURE0);
    tgl.bindTexture(tgl.TEXTURE_2D, this.thumbHeightTex);
    tgl.uniform1i(tgl.getUniformLocation(prog, "uHeightTex"), 0);
    tgl.uniformMatrix4fv(tgl.getUniformLocation(prog, "uViewProj"), false, vp);
    tgl.uniform4f(tgl.getUniformLocation(prog, "uCameraPos"), eye[0], eye[1], eye[2], 1.0);
    tgl.uniform4f(
      tgl.getUniformLocation(prog, "uStockMin"),
      stock.min[0],
      stock.min[1],
      stock.min[2],
      darkMode ? 0.0 : 1.0
    );
    tgl.uniform4f(
      tgl.getUniformLocation(prog, "uStockMax"),
      stock.max[0],
      stock.max[1],
      stock.max[2],
      0.0
    );
    tgl.uniform4f(tgl.getUniformLocation(prog, "uGridInfo"), gw, gh, cellDx, cellDy);
    tgl.uniform4f(tgl.getUniformLocation(prog, "uSectionInfo"), 0.0, 0.0, 0.0, 1.0);

    const topVerts = (gw - 1) * (gh - 1) * 6;
    const skirtVerts = 2 * (gw - 1 + (gh - 1)) * 6;
    const locStyle = tgl.getUniformLocation(prog, "uStyleInfo");

    tgl.uniform4f(locStyle, materialId, 0.0, 1.0, 0.0);
    tgl.drawArrays(tgl.TRIANGLES, 0, topVerts);
    tgl.uniform4f(locStyle, materialId, 1.0, 1.0, 0.0);
    tgl.drawArrays(tgl.TRIANGLES, 0, skirtVerts);
    tgl.uniform4f(locStyle, materialId, 2.0, 1.0, 0.0);
    tgl.drawArrays(tgl.TRIANGLES, 0, topVerts);

    return this.thumbCanvas.toDataURL("image/webp", 0.9);
  }

  destroy() {
    const gl = this.gl;
    if (gl) {
      gl.deleteTexture(this.heightTex);
      gl.deleteBuffer(this.lineVbo);
      gl.deleteVertexArray(this.emptyVao);
      gl.deleteVertexArray(this.lineVao);
      gl.deleteProgram(this.partProg);
      gl.deleteProgram(this.lineProg);
    }
    if (this.thumbGl) {
      this.thumbGl.deleteTexture(this.thumbHeightTex);
      this.thumbGl.deleteVertexArray(this.thumbVao);
      this.thumbGl.deleteProgram(this.thumbPartProg);
    }
  }
}
