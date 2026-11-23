import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useI18n } from "../i18n/I18nContext";
import { TranslationKey } from "../i18n/locales";

export interface MaterialOption {
  id: number;
  nameKey: TranslationKey;
  descKey: TranslationKey;
}

export const MATERIAL_OPTIONS: MaterialOption[] = [
  { id: 4, nameKey: "material.4.name", descKey: "material.4.desc" },
  { id: 1, nameKey: "material.1.name", descKey: "material.1.desc" },
  { id: 0, nameKey: "material.0.name", descKey: "material.0.desc" },
  { id: 2, nameKey: "material.2.name", descKey: "material.2.desc" },
  { id: 3, nameKey: "material.3.name", descKey: "material.3.desc" },
  { id: 5, nameKey: "material.5.name", descKey: "material.5.desc" },
];

/**
 * Studio-lit 3D Material Sphere SVG swatch (wood rings / brushed metal / jade translucency).
 */
export const MaterialSphereIcon: React.FC<{
  materialId: number;
  size?: number;
}> = ({ materialId, size = 26 }) => {
  const uid = `mat-${materialId}-${size}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
    >
      <defs>
        <clipPath id={`clip-${uid}`}>
          <circle cx="16" cy="16" r="13" />
        </clipPath>

        {/* Pine Wood */}
        <radialGradient id={`pine-${uid}`} cx="36%" cy="32%" r="70%">
          <stop offset="0%" stopColor="#fbf0d9" />
          <stop offset="58%" stopColor="#ecd2a4" />
          <stop offset="100%" stopColor="#be9055" />
        </radialGradient>

        {/* Rosewood */}
        <radialGradient id={`rose-${uid}`} cx="35%" cy="30%" r="72%">
          <stop offset="0%" stopColor="#dfa072" />
          <stop offset="52%" stopColor="#ad6536" />
          <stop offset="100%" stopColor="#5e2d12" />
        </radialGradient>

        {/* 6061 Aluminum */}
        <radialGradient id={`alu-${uid}`} cx="34%" cy="28%" r="74%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="38%" stopColor="#dbe4ee" />
          <stop offset="76%" stopColor="#8997a9" />
          <stop offset="100%" stopColor="#4c5869" />
        </radialGradient>

        {/* H62 Brass */}
        <radialGradient id={`brass-${uid}`} cx="34%" cy="28%" r="74%">
          <stop offset="0%" stopColor="#fff8d6" />
          <stop offset="36%" stopColor="#f3cf68" />
          <stop offset="75%" stopColor="#b98a28" />
          <stop offset="100%" stopColor="#6c4d10" />
        </radialGradient>

        {/* Celadon Jade */}
        <radialGradient id={`jade-${uid}`} cx="36%" cy="30%" r="72%">
          <stop offset="0%" stopColor="#d8faee" />
          <stop offset="48%" stopColor="#72cfb2" />
          <stop offset="82%" stopColor="#358f74" />
          <stop offset="100%" stopColor="#246350" />
        </radialGradient>

        {/* Depth Elevation Heatmap */}
        <linearGradient id={`heat-${uid}`} x1="15%" y1="10%" x2="85%" y2="92%">
          <stop offset="0%" stopColor="#2e57d1" />
          <stop offset="26%" stopColor="#0fb8db" />
          <stop offset="52%" stopColor="#29cc70" />
          <stop offset="76%" stopColor="#f5d12e" />
          <stop offset="100%" stopColor="#eb3d2e" />
        </linearGradient>
      </defs>

      <g clipPath={`url(#clip-${uid})`}>
        {materialId === 4 && (
          <>
            <circle cx="16" cy="16" r="13" fill={`url(#pine-${uid})`} />
            {/* Flowing golden-amber pine growth rings */}
            <path
              d="M2 12 Q14 7 30 14 M2 18 Q15 13 30 20 M3 24 Q16 19 29 26"
              stroke="#c48f4d"
              strokeOpacity="0.55"
              strokeWidth="1.5"
              fill="none"
            />
            <ellipse cx="12" cy="10" rx="4.5" ry="2.2" transform="rotate(-24 12 10)" fill="#ffffff" fillOpacity="0.35" />
          </>
        )}

        {materialId === 1 && (
          <>
            <circle cx="16" cy="16" r="13" fill={`url(#rose-${uid})`} />
            {/* Dense Rosewood grain */}
            <path
              d="M2 10 Q15 5 30 12 M2 15 Q16 10 30 17 M2 20 Q16 15 30 22 M3 25 Q16 20 29 27"
              stroke="#4d220b"
              strokeOpacity="0.48"
              strokeWidth="1.35"
              fill="none"
            />
            <ellipse cx="11.5" cy="9.5" rx="4.8" ry="2.3" transform="rotate(-25 11.5 9.5)" fill="#ffffff" fillOpacity="0.32" />
          </>
        )}

        {materialId === 0 && (
          <>
            <circle cx="16" cy="16" r="13" fill={`url(#alu-${uid})`} />
            {/* Metallic studio horizon reflection band */}
            <path
              d="M2 19 Q16 23 30 17"
              stroke="#334155"
              strokeOpacity="0.35"
              strokeWidth="2.4"
              fill="none"
            />
            <path
              d="M4 23 Q16 27 28 21"
              stroke="#f8fafc"
              strokeOpacity="0.45"
              strokeWidth="1.5"
              fill="none"
            />
            <ellipse cx="11.5" cy="9.2" rx="4.2" ry="2.1" transform="rotate(-28 11.5 9.2)" fill="#ffffff" fillOpacity="0.88" />
          </>
        )}

        {materialId === 2 && (
          <>
            <circle cx="16" cy="16" r="13" fill={`url(#brass-${uid})`} />
            <path
              d="M2 19 Q16 23 30 17"
              stroke="#5c3f09"
              strokeOpacity="0.38"
              strokeWidth="2.4"
              fill="none"
            />
            <path
              d="M4 23 Q16 27 28 21"
              stroke="#fef08a"
              strokeOpacity="0.52"
              strokeWidth="1.5"
              fill="none"
            />
            <ellipse cx="11.5" cy="9.2" rx="4.2" ry="2.1" transform="rotate(-28 11.5 9.2)" fill="#ffffff" fillOpacity="0.90" />
          </>
        )}

        {materialId === 3 && (
          <>
            <circle cx="16" cy="16" r="13" fill={`url(#jade-${uid})`} />
            {/* Subsurface jadeite lower glow */}
            <ellipse cx="18" cy="23" rx="7.5" ry="4" fill="#a7f3d0" fillOpacity="0.35" />
            <ellipse cx="11.5" cy="9.2" rx="4.0" ry="1.9" transform="rotate(-26 11.5 9.2)" fill="#ffffff" fillOpacity="0.82" />
          </>
        )}

        {materialId === 5 && (
          <>
            <circle cx="16" cy="16" r="13" fill={`url(#heat-${uid})`} />
            {/* Subtle 1mm topographic isolines */}
            <path
              d="M3 11 Q16 15 29 9 M3 17 Q16 21 29 15 M4 23 Q16 27 28 21"
              stroke="#09090b"
              strokeOpacity="0.28"
              strokeWidth="1.05"
              fill="none"
            />
            <ellipse cx="11.5" cy="9.2" rx="4.0" ry="1.9" transform="rotate(-26 11.5 9.2)" fill="#ffffff" fillOpacity="0.72" />
          </>
        )}
      </g>

      {/* Crisp subtle rim border */}
      <circle
        cx="16"
        cy="16"
        r="13"
        stroke="currentColor"
        strokeOpacity="0.22"
        strokeWidth="1"
      />
    </svg>
  );
};

interface MaterialSelectProps {
  materialId: number;
  onSelectMaterial: (id: number) => void;
}

export const MaterialSelect: React.FC<MaterialSelectProps> = ({
  materialId,
  onSelectMaterial,
}) => {
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

  const current =
    MATERIAL_OPTIONS.find((m) => m.id === materialId) ?? MATERIAL_OPTIONS[0];

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
          <MaterialSphereIcon materialId={current.id} size={22} />
          <span className="tool-trigger-label">{t(current.nameKey)}</span>
        </div>
        <ChevronDown size={14} className={`dd-chevron ${open ? "rotated" : ""}`} />
      </button>

      {open && (
        <div className="sh-dropdown-menu" role="listbox">
          <div className="sh-dropdown-label">{t("material.dropdownLabel")}</div>
          {MATERIAL_OPTIONS.map((m) => {
            const selected = m.id === materialId;
            return (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={selected}
                className={`sh-dropdown-item ${selected ? "selected" : ""}`}
                onClick={() => {
                  onSelectMaterial(m.id);
                  setOpen(false);
                }}
              >
                <div className="dd-avatar-sphere">
                  <MaterialSphereIcon materialId={m.id} size={28} />
                </div>
                <div className="tool-opt-meta">
                  <span className="tool-opt-title">{t(m.nameKey)}</span>
                  <span className="tool-opt-desc">{t(m.descKey)}</span>
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
