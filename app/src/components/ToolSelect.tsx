import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useI18n } from "../i18n/I18nContext";
import { TranslationKey } from "../i18n/locales";
import { ToolKind, ToolSpec } from "../types";

const TOOL_NAME_KEYS: Record<ToolKind, TranslationKey> = {
  flat_end_mill: "tool.flat_end_mill.name",
  ball_nose: "tool.ball_nose.name",
  tapered_ball_nose: "tool.tapered_ball_nose.name",
  bull_nose: "tool.bull_nose.name",
  v_bit: "tool.v_bit.name",
};

const TOOL_DESC_KEYS: Record<ToolKind, TranslationKey> = {
  flat_end_mill: "tool.flat_end_mill.desc",
  ball_nose: "tool.ball_nose.desc",
  tapered_ball_nose: "tool.tapered_ball_nose.desc",
  bull_nose: "tool.bull_nose.desc",
  v_bit: "tool.v_bit.desc",
};

const TOOL_ORDER: ToolKind[] = [
  "flat_end_mill",
  "ball_nose",
  "tapered_ball_nose",
  "bull_nose",
  "v_bit",
];

/**
 * Crisp technical SVG silhouette + helical flute lines for each 3-axis cutter type.
 */
export const CutterSvgIcon: React.FC<{
  kind: ToolKind;
  size?: number;
}> = ({ kind, size = 28 }) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="cutter-svg-icon"
    >
      <defs>
        <linearGradient id={`shank-${kind}`} x1="8" y1="0" x2="24" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#94a3b8" />
          <stop offset="42%" stopColor="#f1f5f9" />
          <stop offset="100%" stopColor="#64748b" />
        </linearGradient>
        <linearGradient id={`flute-${kind}`} x1="7" y1="10" x2="25" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#cbd5e1" />
          <stop offset="45%" stopColor="#f8fafc" />
          <stop offset="100%" stopColor="#475569" />
        </linearGradient>
      </defs>

      {/* Upper Shank */}
      <rect
        x="10"
        y="2"
        width="12"
        height="9"
        rx="1"
        fill={`url(#shank-${kind})`}
        stroke="currentColor"
        strokeOpacity="0.45"
        strokeWidth="1"
      />

      {kind === "flat_end_mill" && (
        <>
          {/* Straight cylinder + sharp 90° flat bottom */}
          <path
            d="M9.5 11 H22.5 V28.5 H9.5 Z"
            fill={`url(#flute-${kind})`}
            stroke="currentColor"
            strokeOpacity="0.7"
            strokeWidth="1.1"
            strokeLinejoin="miter"
          />
          {/* Helical flute grooves */}
          <path
            d="M10 15.5 L22 12 M10 21.5 L22 18 M10 27.5 L22 24"
            stroke="currentColor"
            strokeOpacity="0.45"
            strokeWidth="1"
          />
          {/* Highlighted bottom cutting edge */}
          <line x1="9" y1="28.5" x2="23" y2="28.5" stroke="#0ea5e9" strokeWidth="1.6" />
        </>
      )}

      {kind === "ball_nose" && (
        <>
          {/* Straight cylinder + hemispherical ball tip */}
          <path
            d="M9.5 11 H22.5 V22.5 A6.5 6.5 0 0 1 9.5 22.5 Z"
            fill={`url(#flute-${kind})`}
            stroke="currentColor"
            strokeOpacity="0.7"
            strokeWidth="1.1"
          />
          <path
            d="M10 15.5 L22 12 M10 21.5 L22 18"
            stroke="currentColor"
            strokeOpacity="0.45"
            strokeWidth="1"
          />
          <path
            d="M9.5 22.5 A6.5 6.5 0 0 0 22.5 22.5"
            stroke="#0ea5e9"
            strokeWidth="1.6"
            fill="none"
          />
        </>
      )}

      {kind === "tapered_ball_nose" && (
        <>
          {/* Tapered cone body + small fine ball tip */}
          <path
            d="M10 11 H22 L18.2 26.8 A2.2 2.2 0 0 1 13.8 26.8 Z"
            fill={`url(#flute-${kind})`}
            stroke="currentColor"
            strokeOpacity="0.7"
            strokeWidth="1.1"
          />
          <path
            d="M11 15.5 L21 12.8 M12.2 21 L19.8 18.5 M13.4 25.5 L18.6 23.8"
            stroke="currentColor"
            strokeOpacity="0.45"
            strokeWidth="1"
          />
          <path
            d="M13.8 26.8 A2.2 2.2 0 0 0 18.2 26.8"
            stroke="#0ea5e9"
            strokeWidth="1.7"
            fill="none"
          />
        </>
      )}

      {kind === "bull_nose" && (
        <>
          {/* Straight cylinder + rounded corner radius + flat center */}
          <path
            d="M9.5 11 H22.5 V25.2 A3.3 3.3 0 0 1 19.2 28.5 H12.8 A3.3 3.3 0 0 1 9.5 25.2 Z"
            fill={`url(#flute-${kind})`}
            stroke="currentColor"
            strokeOpacity="0.7"
            strokeWidth="1.1"
          />
          <path
            d="M10 15.5 L22 12 M10 21.5 L22 18"
            stroke="currentColor"
            strokeOpacity="0.45"
            strokeWidth="1"
          />
          <path
            d="M9.5 25.2 A3.3 3.3 0 0 0 12.8 28.5 H19.2 A3.3 3.3 0 0 0 22.5 25.2"
            stroke="#0ea5e9"
            strokeWidth="1.6"
            fill="none"
          />
        </>
      )}

      {kind === "v_bit" && (
        <>
          {/* Short collar + sharp V-engraving cone tip */}
          <path
            d="M9 11 H23 V15 L16 29 L9 15 Z"
            fill={`url(#flute-${kind})`}
            stroke="currentColor"
            strokeOpacity="0.7"
            strokeWidth="1.1"
            strokeLinejoin="round"
          />
          <line
            x1="16"
            y1="14.5"
            x2="16"
            y2="28.5"
            stroke="currentColor"
            strokeOpacity="0.4"
            strokeWidth="1"
          />
          <path
            d="M9.2 15.2 L16 29 L22.8 15.2"
            stroke="#0ea5e9"
            strokeWidth="1.6"
            strokeLinejoin="round"
            fill="none"
          />
        </>
      )}
    </svg>
  );
};

/**
 * Live proportional 2D CAD cross-section badge reflecting actual D / R / α parameters.
 */
export const LiveCutterDiagram: React.FC<{ tool: ToolSpec }> = ({ tool }) => {
  const { t } = useI18n();
  const outerR = Math.max(tool.diameter * 0.5, 0.2);
  // Normalize width to 26px max in a 48x44 viewBox
  const halfW = 11;
  const topY = 5;
  const botY = 39;
  const fluteTopY = 14;

  let pathD = "";
  let accentD = "";

  if (tool.kind === "flat_end_mill") {
    pathD = `M ${24 - halfW} ${fluteTopY} H ${24 + halfW} V ${botY} H ${24 - halfW} Z`;
    accentD = `M ${24 - halfW} ${botY} H ${24 + halfW}`;
  } else if (tool.kind === "ball_nose") {
    const rPx = halfW;
    const cy = botY - rPx;
    pathD = `M ${24 - halfW} ${fluteTopY} H ${24 + halfW} V ${cy} A ${rPx} ${rPx} 0 0 1 ${24 - halfW} ${cy} Z`;
    accentD = `M ${24 - halfW} ${cy} A ${rPx} ${rPx} 0 0 0 ${24 + halfW} ${cy}`;
  } else if (tool.kind === "bull_nose") {
    const ratio = Math.min(Math.max(tool.tip_radius / outerR, 0.08), 0.95);
    const crPx = Math.max(halfW * ratio, 1.8);
    pathD = `M ${24 - halfW} ${fluteTopY} H ${24 + halfW} V ${botY - crPx} A ${crPx} ${crPx} 0 0 1 ${24 + halfW - crPx} ${botY} H ${24 - halfW + crPx} A ${crPx} ${crPx} 0 0 1 ${24 - halfW} ${botY - crPx} Z`;
    accentD = `M ${24 - halfW} ${botY - crPx} A ${crPx} ${crPx} 0 0 0 ${24 - halfW + crPx} ${botY} H ${24 + halfW - crPx} A ${crPx} ${crPx} 0 0 0 ${24 + halfW} ${botY - crPx}`;
  } else {
    // Tapered ballnose or V-bit
    const tipRatio =
      tool.kind === "v_bit"
        ? 0.04
        : Math.min(Math.max(tool.tip_radius / outerR, 0.08), 0.75);
    const tipR = Math.max(halfW * tipRatio, 0.8);
    const angRad = (Math.min(Math.max(tool.half_angle_deg, 1), 65) * Math.PI) / 180;
    const dyFlute = botY - tipR - fluteTopY;
    const topHalfW = Math.min(Math.max(tipR + Math.tan(angRad) * dyFlute * 0.45, tipR + 1.5), 16);
    pathD = `M ${24 - topHalfW} ${fluteTopY} H ${24 + topHalfW} L ${24 + tipR} ${botY - tipR} A ${tipR} ${tipR} 0 0 1 ${24 - tipR} ${botY - tipR} Z`;
    accentD = `M ${24 - topHalfW} ${fluteTopY} L ${24 - tipR} ${botY - tipR} A ${tipR} ${tipR} 0 0 0 ${24 + tipR} ${botY - tipR} L ${24 + topHalfW} ${fluteTopY}`;
  }

  return (
    <div className="live-cutter-preview" title={t("tool.diagramTip")}>
      <svg width="48" height="44" viewBox="0 0 48 44" fill="none">
        <rect
          x="18"
          y={topY}
          width="12"
          height={fluteTopY - topY}
          fill="currentColor"
          fillOpacity="0.16"
          stroke="currentColor"
          strokeOpacity="0.4"
          strokeWidth="1"
        />
        <path
          d={pathD}
          fill="currentColor"
          fillOpacity="0.09"
          stroke="currentColor"
          strokeOpacity="0.55"
          strokeWidth="1.1"
        />
        <path d={accentD} stroke="#0ea5e9" strokeWidth="1.6" fill="none" />
        {/* Center axis dashed line */}
        <line
          x1="24"
          y1="2"
          x2="24"
          y2="42"
          stroke="currentColor"
          strokeOpacity="0.22"
          strokeDasharray="2 2"
          strokeWidth="0.9"
        />
      </svg>
      <div className="live-cutter-specs">
        <span>Ø{tool.diameter.toFixed(2)} mm</span>
        {(tool.kind === "tapered_ball_nose" || tool.kind === "bull_nose") && (
          <span>R{tool.tip_radius.toFixed(2)} mm</span>
        )}
        {(tool.kind === "tapered_ball_nose" || tool.kind === "v_bit") && (
          <span>α {tool.half_angle_deg.toFixed(1)}°</span>
        )}
      </div>
    </div>
  );
};

interface ToolSelectProps {
  tool: ToolSpec;
  onSelectKind: (kind: ToolKind) => void;
}

export const ToolSelect: React.FC<ToolSelectProps> = ({ tool, onSelectKind }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState<boolean>(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDocDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDocDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="tool-select-container" ref={wrapRef}>
      <button
        type="button"
        className={`tool-select-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <div className="tool-trigger-left">
          <CutterSvgIcon kind={tool.kind} size={23} />
          <span className="tool-trigger-label">{t(TOOL_NAME_KEYS[tool.kind])}</span>
        </div>
        <ChevronDown size={14} className={`dd-chevron ${open ? "rotated" : ""}`} />
      </button>

      {open && (
        <div className="sh-dropdown-menu" role="listbox">
          <div className="sh-dropdown-label">{t("tool.dropdownLabel")}</div>
          {TOOL_ORDER.map((k) => {
            const selected = tool.kind === k;
            return (
              <button
                key={k}
                type="button"
                role="option"
                aria-selected={selected}
                className={`sh-dropdown-item ${selected ? "selected" : ""}`}
                onClick={() => {
                  onSelectKind(k);
                  setOpen(false);
                }}
              >
                <div className="tool-opt-icon-box">
                  <CutterSvgIcon kind={k} size={27} />
                </div>
                <div className="tool-opt-meta">
                  <span className="tool-opt-title">{t(TOOL_NAME_KEYS[k])}</span>
                  <span className="tool-opt-desc">{t(TOOL_DESC_KEYS[k])}</span>
                </div>
                {selected && (
                  <span className="sh-check-badge">
                    <Check size={11} strokeWidth={2.6} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
