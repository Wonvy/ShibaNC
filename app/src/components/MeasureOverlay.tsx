import React from "react";
import { X } from "lucide-react";
import { useI18n } from "../i18n/I18nContext";

export interface MeasurementPair {
  id: number;
  p1: [number, number, number];
  p2: [number, number, number];
}

interface ProjectedPt {
  x: number;
  y: number;
  visible: boolean;
}

interface MeasureOverlayProps {
  stockTopZ: number;
  measurements: MeasurementPair[];
  pendingP1: [number, number, number] | null;
  hoverWorld: [number, number, number] | null;
  projectWorld: (pt: [number, number, number]) => ProjectedPt;
  onRemoveMeasurement: (id: number) => void;
  onClearAll: () => void;
}

export const MeasureOverlay: React.FC<MeasureOverlayProps> = ({
  stockTopZ,
  measurements,
  pendingP1,
  hoverWorld,
  projectWorld,
  onRemoveMeasurement,
  onClearAll,
}) => {
  const { t } = useI18n();
  const renderDimensionPair = (
    p1: [number, number, number],
    p2: [number, number, number],
    id: number | null,
    isPreview: boolean
  ) => {
    const s1 = projectWorld(p1);
    const s2 = projectWorld(p2);
    if (!s1.visible || !s2.visible) return null;

    // Orthogonal corner projections to visualize ΔX / ΔY / ΔZ in 3D space
    const pCornerXY: [number, number, number] = [p2[0], p2[1], p1[2]];
    const pCornerX: [number, number, number] = [p2[0], p1[1], p1[2]];
    const sCornerXY = projectWorld(pCornerXY);
    const sCornerX = projectWorld(pCornerX);

    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const dz = p2[2] - p1[2];
    const dist3d = Math.hypot(dx, dy, dz);
    const distXY = Math.hypot(dx, dy);

    const midX = 0.5 * (s1.x + s2.x);
    const midY = 0.5 * (s1.y + s2.y);

    return (
      <g key={id ?? "preview"}>
        {/* 3D Orthogonal ΔX (Red), ΔY (Green), ΔZ (Blue) component helper lines */}
        {sCornerX.visible && Math.abs(dx) > 0.05 && (
          <line
            x1={s1.x}
            y1={s1.y}
            x2={sCornerX.x}
            y2={sCornerX.y}
            stroke="#ef4444"
            strokeWidth="1.15"
            strokeDasharray="3 2.5"
            strokeOpacity="0.78"
          />
        )}
        {sCornerX.visible && sCornerXY.visible && Math.abs(dy) > 0.05 && (
          <line
            x1={sCornerX.x}
            y1={sCornerX.y}
            x2={sCornerXY.x}
            y2={sCornerXY.y}
            stroke="#10b981"
            strokeWidth="1.15"
            strokeDasharray="3 2.5"
            strokeOpacity="0.78"
          />
        )}
        {sCornerXY.visible && Math.abs(dz) > 0.05 && (
          <line
            x1={sCornerXY.x}
            y1={sCornerXY.y}
            x2={s2.x}
            y2={s2.y}
            stroke="#3b82f6"
            strokeWidth="1.25"
            strokeDasharray="3 2.5"
            strokeOpacity="0.82"
          />
        )}

        {/* Primary Direct 3D Measurement Line (Halo + Crisp Foreground) */}
        <line
          x1={s1.x}
          y1={s1.y}
          x2={s2.x}
          y2={s2.y}
          stroke="rgba(9, 9, 11, 0.45)"
          strokeWidth="3.6"
          strokeLinecap="round"
        />
        <line
          x1={s1.x}
          y1={s1.y}
          x2={s2.x}
          y2={s2.y}
          stroke={isPreview ? "#38bdf8" : "#0ea5e9"}
          strokeWidth="1.9"
          strokeDasharray={isPreview ? "5 3" : undefined}
          strokeLinecap="round"
        />

        {/* Endpoint Anchor Dots */}
        <circle cx={s1.x} cy={s1.y} r="4.5" fill="#ffffff" stroke="#0ea5e9" strokeWidth="2" />
        <circle cx={s2.x} cy={s2.y} r="4.5" fill="#ffffff" stroke="#0ea5e9" strokeWidth="2" />

        {/* Floating shadcn/ui Dimension Readout Badge at Midpoint */}
        <foreignObject
          x={midX - 108}
          y={midY - 30}
          width={216}
          height={64}
          style={{ overflow: "visible", pointerEvents: isPreview ? "none" : "auto" }}
        >
          <div className={`measure-badge ${isPreview ? "preview" : ""}`}>
            <div className="measure-main-row">
              <span className="measure-dist">{dist3d.toFixed(2)} mm</span>
              {!isPreview && id !== null && (
                <button
                  type="button"
                  className="measure-del-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveMeasurement(id);
                  }}
                  title={t("measure.deleteTip")}
                >
                  <X size={11} />
                </button>
              )}
            </div>
            <div className="measure-sub-row">
              <span>{t("measure.horiz", { val: distXY.toFixed(2) })}</span>
              <span className="m-dx">ΔX {Math.abs(dx).toFixed(2)}</span>
              <span className="m-dy">ΔY {Math.abs(dy).toFixed(2)}</span>
              <span className="m-dz">ΔZ {Math.abs(dz).toFixed(2)}</span>
            </div>
          </div>
        </foreignObject>
      </g>
    );
  };

  const sHover = hoverWorld ? projectWorld(hoverWorld) : null;
  const sPending = pendingP1 ? projectWorld(pendingP1) : null;
  const cutDepth = hoverWorld ? stockTopZ - hoverWorld[2] : 0;

  return (
    <div className="measure-layer">
      {/* Top-Center Measurement Instruction / Clear Bar */}
      <div className="measure-hint-bar">
        <span>
          {pendingP1 ? t("measure.hintPending") : t("measure.hintIdle")}
        </span>
        {(measurements.length > 0 || pendingP1) && (
          <button type="button" className="measure-clear-btn" onClick={onClearAll}>
            {t("measure.clear", { count: measurements.length })}
          </button>
        )}
      </div>

      <svg className="measure-svg" width="100%" height="100%">
        {/* Locked Measurements */}
        {measurements.map((m) => renderDimensionPair(m.p1, m.p2, m.id, false))}

        {/* Live Rubber-Band Preview (P1 -> Hover) */}
        {pendingP1 && hoverWorld && renderDimensionPair(pendingP1, hoverWorld, null, true)}

        {/* Single P1 Anchor if cursor moved off model */}
        {pendingP1 && !hoverWorld && sPending?.visible && (
          <circle
            cx={sPending.x}
            cy={sPending.y}
            r="5"
            fill="#ffffff"
            stroke="#0ea5e9"
            strokeWidth="2.2"
          />
        )}

        {/* Live Surface Snapping Crosshair */}
        {hoverWorld && sHover?.visible && (
          <g style={{ pointerEvents: "none" }}>
            <circle
              cx={sHover.x}
              cy={sHover.y}
              r="7.5"
              fill="rgba(14, 165, 233, 0.16)"
              stroke="#0ea5e9"
              strokeWidth="1.4"
            />
            <circle cx={sHover.x} cy={sHover.y} r="2.3" fill="#0ea5e9" />
          </g>
        )}
      </svg>

      {/* Live Surface XYZ & Cut-Depth Probe Tooltip near Cursor */}
      {hoverWorld && sHover?.visible && !pendingP1 && (
        <div
          className="measure-probe-tip"
          style={{
            left: sHover.x + 14,
            top: sHover.y + 12,
          }}
        >
          <div className="probe-depth">
            {t("measure.depth")}{" "}
            <b>
              {cutDepth >= -0.01
                ? `${Math.max(cutDepth, 0).toFixed(2)} mm`
                : `${cutDepth.toFixed(2)} mm`}
            </b>
          </div>
          <div className="probe-xyz">
            X {hoverWorld[0].toFixed(2)} · Y {hoverWorld[1].toFixed(2)} · Z {hoverWorld[2].toFixed(2)}
          </div>
        </div>
      )}
    </div>
  );
};
