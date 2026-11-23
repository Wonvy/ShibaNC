import React from "react";
import { useI18n } from "../i18n/I18nContext";
import { StockSpec } from "../types";

interface StockDiagramProps {
  stock: StockSpec;
  cutBoundsMin?: [number, number, number];
  cutBoundsMax?: [number, number, number];
  xyOriginMode: "center" | "corner";
  zDatumAnchor: "top" | "bottom";
  materialId: number;
}

const MAT_PALETTES: Record<
  number,
  { top: string; left: string; right: string; stroke: string }
> = {
  4: {
    // Pine Wood (松木)
    top: "#f3e1be",
    right: "#dfc394",
    left: "#cca974",
    stroke: "#9a7442",
  },
  1: {
    // Rosewood (花梨木)
    top: "#c98856",
    right: "#a86839",
    left: "#8b5028",
    stroke: "#663718",
  },
  0: {
    // 6061 Aluminum (航空铝)
    top: "#e2e8f0",
    right: "#cbd5e1",
    left: "#94a3b8",
    stroke: "#64748b",
  },
  2: {
    // Brass (黄铜)
    top: "#f5d77f",
    right: "#dfb952",
    left: "#c09935",
    stroke: "#8c6b1c",
  },
  3: {
    // Jade (翡翠玉)
    top: "#9ee0cb",
    right: "#74c6ad",
    left: "#53ab91",
    stroke: "#2f7a64",
  },
  5: {
    // Depth Elevation Heatmap (切深等高云图)
    top: "#7dd3fc",
    right: "#34d399",
    left: "#fbbf24",
    stroke: "#0284c7",
  },
};

export const StockDiagram: React.FC<StockDiagramProps> = ({
  stock,
  cutBoundsMin,
  cutBoundsMax,
  xyOriginMode,
  zDatumAnchor,
  materialId,
}) => {
  const { t } = useI18n();
  const sx = Math.max(stock.max[0] - stock.min[0], 1);
  const sy = Math.max(stock.max[1] - stock.min[1], 1);
  const sz = Math.max(stock.max[2] - stock.min[2], 0.1);

  // Normalized proportional dimensions so changes to X, Y, Z visually reshape the 3D block
  const maxXY = Math.max(sx, sy, 1);
  const nx = Math.min(Math.max(sx / maxXY, 0.36), 1.0);
  const ny = Math.min(Math.max(sy / maxXY, 0.36), 1.0);
  const nz = Math.min(Math.max(sz / maxXY, 0.10), 0.65);

  const scaleX = 68 * nx;
  const scaleY = 58 * ny;
  const scaleZ = Math.min(Math.max(48 * nz, 7), 34);

  // Axonometric vectors matching the default 3D viewport camera (yaw = -35°, pitch = 47°)
  // +X goes up-right, +Y goes up-left, +Z goes straight up
  const vx = { x: 0.85, y: -0.42 };
  const vy = { x: -0.76, y: -0.48 };

  // Center the projected bounding box inside the 236x116 SVG
  const rawMinX = ny * 58 * vy.x;
  const rawMaxX = nx * 68 * vx.x;
  const rawMinY = scaleX * vx.y + scaleY * vy.y - scaleZ;
  const rawMaxY = 0;

  const originBaseX = 118 - 0.5 * (rawMinX + rawMaxX);
  const originBaseY = 60 - 0.5 * (rawMinY + rawMaxY);

  // Project normalized [u, v, w] in [0..1]^3 to 2D SVG coordinates
  const proj = (u: number, v: number, w: number) => ({
    x: originBaseX + u * scaleX * vx.x + v * scaleY * vy.x,
    y: originBaseY + u * scaleX * vx.y + v * scaleY * vy.y - w * scaleZ,
  });

  const p000 = proj(0, 0, 0); // Front-bottom corner (xmin, ymin, zmin)
  const p100 = proj(1, 0, 0); // Right-bottom corner (xmax, ymin, zmin)
  const p010 = proj(0, 1, 0); // Left-bottom corner  (xmin, ymax, zmin)
  const p001 = proj(0, 0, 1); // Front-top corner    (xmin, ymin, zmax)
  const p101 = proj(1, 0, 1); // Right-top corner    (xmax, ymin, zmax)
  const p011 = proj(0, 1, 1); // Left-top corner     (xmin, ymax, zmax)
  const p111 = proj(1, 1, 1); // Back-top corner     (xmax, ymax, zmax)

  const pts = (arr: { x: number; y: number }[]) =>
    arr.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  const pal = MAT_PALETTES[materialId] ?? MAT_PALETTES[0];

  // Compute toolpath footprint UV [u0..u1, v0..v1] on top face if available
  let footprintPoly: string | null = null;
  let outOfBounds = false;
  if (cutBoundsMin && cutBoundsMax && Number.isFinite(cutBoundsMin[0])) {
    const rawU0 = (cutBoundsMin[0] - stock.min[0]) / sx;
    const rawU1 = (cutBoundsMax[0] - stock.min[0]) / sx;
    const rawV0 = (cutBoundsMin[1] - stock.min[1]) / sy;
    const rawV1 = (cutBoundsMax[1] - stock.min[1]) / sy;
    outOfBounds = rawU0 < -0.01 || rawU1 > 1.01 || rawV0 < -0.01 || rawV1 > 1.01;
    const u0 = Math.min(Math.max(rawU0, 0), 1);
    const u1 = Math.min(Math.max(rawU1, 0), 1);
    const v0 = Math.min(Math.max(rawV0, 0), 1);
    const v1 = Math.min(Math.max(rawV1, 0), 1);
    if (u1 - u0 > 0.03 && v1 - v0 > 0.03) {
      footprintPoly = pts([
        proj(u0, v0, 1),
        proj(u1, v0, 1),
        proj(u1, v1, 1),
        proj(u0, v1, 1),
      ]);
    }
  }

  // WCS Zero Origin dot position
  const origU = xyOriginMode === "corner" ? 0 : 0.5;
  const origV = xyOriginMode === "corner" ? 0 : 0.5;
  const origW = zDatumAnchor === "top" ? 1 : 0;
  const pOrig = proj(origU, origV, origW);
  const pOrigTop = proj(origU, origV, 1);

  // Dimension line offset helpers
  // X dimension along front-right bottom edge (p000 -> p100), shifted down-right
  const offX = { x: 5.5, y: 8.5 };
  const xDimA = { x: p000.x + offX.x, y: p000.y + offX.y };
  const xDimB = { x: p100.x + offX.x, y: p100.y + offX.y };
  const xMid = { x: 0.5 * (xDimA.x + xDimB.x) + 4, y: 0.5 * (xDimA.y + xDimB.y) + 9 };

  // Y dimension along front-left bottom edge (p000 -> p010), shifted down-left
  const offY = { x: -6.0, y: 8.5 };
  const yDimA = { x: p000.x + offY.x, y: p000.y + offY.y };
  const yDimB = { x: p010.x + offY.x, y: p010.y + offY.y };
  const yMid = { x: 0.5 * (yDimA.x + yDimB.x) - 6, y: 0.5 * (yDimA.y + yDimB.y) + 9 };

  // Z thickness dimension along right vertical edge (p100 -> p101), shifted right
  const zExtX = p100.x + 11;
  const zMidY = 0.5 * (p100.y + p101.y);

  const fmtDim = (v: number) => {
    const s = v.toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };

  return (
    <div className="stock-diagram-card" title={t("stock.diagramTip")}>
      <svg width="100%" height="116" viewBox="0 0 236 116" fill="none">
        {/* Top Face (+Z) */}
        <polygon
          points={pts([p001, p101, p111, p011])}
          fill={pal.top}
          stroke={pal.stroke}
          strokeWidth="1"
          strokeLinejoin="round"
        />
        {/* Front-Left Face (-X / Y-Z wall) */}
        <polygon
          points={pts([p000, p001, p011, p010])}
          fill={pal.left}
          stroke={pal.stroke}
          strokeWidth="1"
          strokeLinejoin="round"
        />
        {/* Front-Right Face (-Y / X-Z wall) */}
        <polygon
          points={pts([p000, p100, p101, p001])}
          fill={pal.right}
          stroke={pal.stroke}
          strokeWidth="1"
          strokeLinejoin="round"
        />

        {/* Toolpath XY Footprint Dashed Preview on Top Face */}
        {footprintPoly && (
          <polygon
            points={footprintPoly}
            fill={outOfBounds ? "rgba(239, 68, 68, 0.14)" : "rgba(14, 165, 233, 0.12)"}
            stroke={outOfBounds ? "#ef4444" : "#0284c7"}
            strokeWidth="1"
            strokeDasharray="2.5 2"
          />
        )}

        {/* X Dimension Callout (Red) */}
        <line
          x1={p000.x}
          y1={p000.y}
          x2={xDimA.x}
          y2={xDimA.y}
          stroke="#ef4444"
          strokeOpacity="0.45"
          strokeWidth="0.9"
        />
        <line
          x1={p100.x}
          y1={p100.y}
          x2={xDimB.x}
          y2={xDimB.y}
          stroke="#ef4444"
          strokeOpacity="0.45"
          strokeWidth="0.9"
        />
        <line
          x1={xDimA.x}
          y1={xDimA.y}
          x2={xDimB.x}
          y2={xDimB.y}
          stroke="#ef4444"
          strokeWidth="1.2"
        />
        <text
          x={xMid.x}
          y={xMid.y}
          fontSize="9.5"
          fontWeight="600"
          fill="#ef4444"
          textAnchor="middle"
          fontFamily="ui-monospace, SFMono-Regular, Consolas, monospace"
        >
          X {fmtDim(sx)}
        </text>

        {/* Y Dimension Callout (Green) */}
        <line
          x1={p000.x}
          y1={p000.y}
          x2={yDimA.x}
          y2={yDimA.y}
          stroke="#10b981"
          strokeOpacity="0.45"
          strokeWidth="0.9"
        />
        <line
          x1={p010.x}
          y1={p010.y}
          x2={yDimB.x}
          y2={yDimB.y}
          stroke="#10b981"
          strokeOpacity="0.45"
          strokeWidth="0.9"
        />
        <line
          x1={yDimA.x}
          y1={yDimA.y}
          x2={yDimB.x}
          y2={yDimB.y}
          stroke="#10b981"
          strokeWidth="1.2"
        />
        <text
          x={yMid.x}
          y={yMid.y}
          fontSize="9.5"
          fontWeight="600"
          fill="#10b981"
          textAnchor="middle"
          fontFamily="ui-monospace, SFMono-Regular, Consolas, monospace"
        >
          Y {fmtDim(sy)}
        </text>

        {/* Z Thickness Dimension Callout (Blue) */}
        <line
          x1={p100.x + 2}
          y1={p100.y}
          x2={zExtX + 3}
          y2={p100.y}
          stroke="#3b82f6"
          strokeOpacity="0.5"
          strokeWidth="0.9"
        />
        <line
          x1={p101.x + 2}
          y1={p101.y}
          x2={zExtX + 3}
          y2={p101.y}
          stroke="#3b82f6"
          strokeOpacity="0.5"
          strokeWidth="0.9"
        />
        <line
          x1={zExtX}
          y1={p100.y}
          x2={zExtX}
          y2={p101.y}
          stroke="#3b82f6"
          strokeWidth="1.3"
        />
        <text
          x={zExtX + 5}
          y={zMidY + 3}
          fontSize="9.5"
          fontWeight="600"
          fill="#3b82f6"
          textAnchor="start"
          fontFamily="ui-monospace, SFMono-Regular, Consolas, monospace"
        >
          Z {fmtDim(sz)}
        </text>

        {/* WCS Workpiece Zero Origin Marker */}
        {zDatumAnchor === "bottom" && (
          <line
            x1={pOrigTop.x}
            y1={pOrigTop.y}
            x2={pOrig.x}
            y2={pOrig.y}
            stroke="#f59e0b"
            strokeWidth="1"
            strokeDasharray="2 1.5"
          />
        )}
        <circle
          cx={pOrig.x}
          cy={pOrig.y}
          r="3.4"
          fill="#ffffff"
          stroke="#09090b"
          strokeWidth="1.4"
        />
        <circle cx={pOrig.x} cy={pOrig.y} r="1.4" fill="#ef4444" />
      </svg>
      {outOfBounds && (
        <div className="stock-warn-tip">{t("stock.outOfBounds")}</div>
      )}
    </div>
  );
};
