import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Maximize2 } from "lucide-react";
import { useI18n } from "../i18n/I18nContext";
import { TranslationKey } from "../i18n/locales";
import { CameraState } from "../types";

export type ViewportLayoutMode = "single" | "dual" | "quad";

export type PanePresetId =
  | "persp_3d"
  | "iso_ortho"
  | "top_xy"
  | "bottom_xy"
  | "front_xz"
  | "back_xz"
  | "right_yz"
  | "left_yz";

export interface PanePresetOption {
  id: PanePresetId;
  labelKey: TranslationKey;
  yawDeg: number;
  pitchDeg: number;
  ortho: boolean;
  lockRotation: boolean;
}

export const PANE_PRESET_KEYS: Record<PanePresetId, TranslationKey> = {
  top_xy: "mv.preset.top_xy",
  front_xz: "mv.preset.front_xz",
  right_yz: "mv.preset.right_yz",
  left_yz: "mv.preset.left_yz",
  back_xz: "mv.preset.back_xz",
  bottom_xy: "mv.preset.bottom_xy",
  iso_ortho: "mv.preset.iso_ortho",
  persp_3d: "mv.preset.persp_3d",
};

export const PANE_PRESETS: PanePresetOption[] = [
  {
    id: "top_xy",
    labelKey: "mv.preset.top_xy",
    yawDeg: 0,
    pitchDeg: 89.2,
    ortho: true,
    lockRotation: true,
  },
  {
    id: "front_xz",
    labelKey: "mv.preset.front_xz",
    yawDeg: 0,
    pitchDeg: 0,
    ortho: true,
    lockRotation: true,
  },
  {
    id: "right_yz",
    labelKey: "mv.preset.right_yz",
    yawDeg: 90,
    pitchDeg: 0,
    ortho: true,
    lockRotation: true,
  },
  {
    id: "left_yz",
    labelKey: "mv.preset.left_yz",
    yawDeg: -90,
    pitchDeg: 0,
    ortho: true,
    lockRotation: true,
  },
  {
    id: "back_xz",
    labelKey: "mv.preset.back_xz",
    yawDeg: 180,
    pitchDeg: 0,
    ortho: true,
    lockRotation: true,
  },
  {
    id: "bottom_xy",
    labelKey: "mv.preset.bottom_xy",
    yawDeg: 0,
    pitchDeg: -89.2,
    ortho: true,
    lockRotation: true,
  },
  {
    id: "iso_ortho",
    labelKey: "mv.preset.iso_ortho",
    yawDeg: -45,
    pitchDeg: 35.26439,
    ortho: true,
    lockRotation: false,
  },
  {
    id: "persp_3d",
    labelKey: "mv.preset.persp_3d",
    yawDeg: -35,
    pitchDeg: 47,
    ortho: false,
    lockRotation: false,
  },
];

export interface AuxPaneState {
  preset: PanePresetId;
  lockRotation: boolean;
  camera: CameraState;
}

export function createDefaultAuxPanes(): [
  AuxPaneState,
  AuxPaneState,
  AuxPaneState
] {
  return [
    {
      preset: "top_xy",
      lockRotation: true,
      camera: {
        yawDeg: 0,
        pitchDeg: 89.2,
        zoom: 1.05,
        panX: 0,
        panY: 0,
        panZ: 0,
        ortho: true,
      },
    },
    {
      preset: "front_xz",
      lockRotation: true,
      camera: {
        yawDeg: 0,
        pitchDeg: 0,
        zoom: 1.05,
        panX: 0,
        panY: 0,
        panZ: 0,
        ortho: true,
      },
    },
    {
      preset: "right_yz",
      lockRotation: true,
      camera: {
        yawDeg: 90,
        pitchDeg: 0,
        zoom: 1.05,
        panX: 0,
        panY: 0,
        panZ: 0,
        ortho: true,
      },
    },
  ];
}

export interface PaneDescriptor {
  /** 0 = Main 3D camera, 1..3 = Aux panes 0..2 */
  paneId: 0 | 1 | 2 | 3;
  rect: [number, number, number, number];
  preset: PanePresetId | "custom_3d";
  lockRotation: boolean;
  camera: CameraState;
}

export function buildActivePanes(
  layout: ViewportLayoutMode,
  splitX: number,
  splitY: number,
  mainCamera: CameraState,
  auxPanes: [AuxPaneState, AuxPaneState, AuxPaneState]
): PaneDescriptor[] {
  if (layout === "single") {
    return [
      {
        paneId: 0,
        rect: [0, 0, 1, 1],
        preset: "custom_3d",
        lockRotation: false,
        camera: mainCamera,
      },
    ];
  }

  if (layout === "dual") {
    return [
      {
        paneId: 0,
        rect: [splitX, 0, 1 - splitX, 1],
        preset: "custom_3d",
        lockRotation: false,
        camera: mainCamera,
      },
      {
        paneId: 1,
        rect: [0, 0, splitX, 1],
        preset: auxPanes[0].preset,
        lockRotation: auxPanes[0].lockRotation,
        camera: auxPanes[0].camera,
      },
    ];
  }

  return [
    {
      paneId: 0,
      rect: [splitX, 0, 1 - splitX, splitY],
      preset: "custom_3d",
      lockRotation: false,
      camera: mainCamera,
    },
    {
      paneId: 1,
      rect: [0, 0, splitX, splitY],
      preset: auxPanes[0].preset,
      lockRotation: auxPanes[0].lockRotation,
      camera: auxPanes[0].camera,
    },
    {
      paneId: 2,
      rect: [0, splitY, splitX, 1 - splitY],
      preset: auxPanes[1].preset,
      lockRotation: auxPanes[1].lockRotation,
      camera: auxPanes[1].camera,
    },
    {
      paneId: 3,
      rect: [splitX, splitY, 1 - splitX, 1 - splitY],
      preset: auxPanes[2].preset,
      lockRotation: auxPanes[2].lockRotation,
      camera: auxPanes[2].camera,
    },
  ];
}

interface MultiViewOverlayProps {
  layout: ViewportLayoutMode;
  splitX: number;
  splitY: number;
  panes: PaneDescriptor[];
  activePaneId: 0 | 1 | 2 | 3;
  containerRef: React.RefObject<HTMLElement | null>;
  onChangeSplit: (nextX: number, nextY: number) => void;
  onSelectPanePreset: (paneId: 0 | 1 | 2 | 3, opt: PanePresetOption) => void;
  onResetPaneFit: (paneId: 0 | 1 | 2 | 3) => void;
  onMaximizePane: (pane: PaneDescriptor) => void;
}

export const MultiViewOverlay: React.FC<MultiViewOverlayProps> = ({
  layout,
  splitX,
  splitY,
  panes,
  activePaneId,
  containerRef,
  onChangeSplit,
  onSelectPanePreset,
  onResetPaneFit,
  onMaximizePane,
}) => {
  const { t } = useI18n();
  const [openMenuPane, setOpenMenuPane] = useState<number | null>(null);
  const [draggingSplit, setDraggingSplit] = useState<
    "v" | "h" | "both" | null
  >(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (openMenuPane === null) return;
    const onDown = (e: MouseEvent) => {
      if (overlayRef.current && !overlayRef.current.contains(e.target as Node)) {
        setOpenMenuPane(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenuPane(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openMenuPane]);

  useEffect(() => {
    if (!draggingSplit) return;
    const onMove = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const nx = Math.min(
        Math.max((e.clientX - rect.left) / Math.max(rect.width, 1), 0.22),
        0.78
      );
      const ny = Math.min(
        Math.max((e.clientY - rect.top) / Math.max(rect.height, 1), 0.22),
        0.78
      );
      if (draggingSplit === "v") {
        onChangeSplit(nx, splitY);
      } else if (draggingSplit === "h") {
        onChangeSplit(splitX, ny);
      } else {
        onChangeSplit(nx, ny);
      }
    };
    const onUp = () => setDraggingSplit(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [draggingSplit, splitX, splitY, containerRef, onChangeSplit]);

  if (layout === "single") return null;

  return (
    <div className="mv-overlay" ref={overlayRef}>
      {/* Vertical Splitter Line */}
      <div
        className={`mv-split-v ${
          draggingSplit === "v" || draggingSplit === "both" ? "dragging" : ""
        }`}
        style={{ left: `${splitX * 100}%` }}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDraggingSplit("v");
        }}
        onDoubleClick={() => onChangeSplit(0.5, splitY)}
        title={t("mv.splitVTip")}
      />

      {/* Horizontal Splitter Line & 4-Way Center Intersection (Quad mode) */}
      {layout === "quad" && (
        <>
          <div
            className={`mv-split-h ${
              draggingSplit === "h" || draggingSplit === "both" ? "dragging" : ""
            }`}
            style={{ top: `${splitY * 100}%` }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDraggingSplit("h");
            }}
            onDoubleClick={() => onChangeSplit(splitX, 0.5)}
            title={t("mv.splitHTip")}
          />
          <div
            className={`mv-split-cross ${
              draggingSplit === "both" ? "dragging" : ""
            }`}
            style={{ left: `${splitX * 100}%`, top: `${splitY * 100}%` }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDraggingSplit("both");
            }}
            onDoubleClick={() => onChangeSplit(0.5, 0.5)}
            title={t("mv.splitCrossTip")}
          />
        </>
      )}

      {/* Per-Pane Blender-style Top-Left View Badges & Preset Switchers */}
      {panes.map((pane) => {
        const [rx, ry] = pane.rect;
        const isActive = pane.paneId === activePaneId;
        const isOpen = openMenuPane === pane.paneId;
        const paneLabel =
          pane.preset === "custom_3d"
            ? pane.camera.ortho
              ? t("mv.customOrtho")
              : t("mv.customPersp")
            : t(PANE_PRESET_KEYS[pane.preset]);

        return (
          <div
            key={pane.paneId}
            className="mv-pane-header"
            style={{
              left: `calc(${rx * 100}% + 10px)`,
              top: `calc(${ry * 100}% + 10px)`,
            }}
          >
            <div className={`mv-badge-group ${isActive ? "active" : ""}`}>
              <button
                type="button"
                className="mv-pane-trigger"
                onClick={() =>
                  setOpenMenuPane((prev) =>
                    prev === pane.paneId ? null : pane.paneId
                  )
                }
                onDoubleClick={() => onMaximizePane(pane)}
                title={t("mv.paneTriggerTip")}
              >
                <span className="mv-active-dot" />
                <span>{paneLabel}</span>
                <ChevronDown
                  size={11}
                  className={`dd-chevron ${isOpen ? "rotated" : ""}`}
                />
              </button>
              <button
                type="button"
                className="mv-max-btn"
                onClick={() => onMaximizePane(pane)}
                title={t("mv.maximizeTip")}
              >
                <Maximize2 size={11} />
              </button>
            </div>

            {isOpen && (
              <div className="sh-dropdown-menu mv-pane-menu" role="menu">
                <div className="sh-dropdown-label">{t("mv.menuTitle")}</div>
                {PANE_PRESETS.map((opt) => {
                  const selected = pane.preset === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={`sh-dropdown-item compact ${
                        selected ? "selected" : ""
                      }`}
                      onClick={() => {
                        onSelectPanePreset(pane.paneId, opt);
                        setOpenMenuPane(null);
                      }}
                    >
                      <span className="mv-opt-label">{t(opt.labelKey)}</span>
                      {selected && (
                        <span className="sh-check-badge">
                          <Check size={10} strokeWidth={2.6} />
                        </span>
                      )}
                    </button>
                  );
                })}
                <div className="section-divider" style={{ margin: "3px 4px" }} />
                <button
                  type="button"
                  className="sh-dropdown-item compact"
                  onClick={() => {
                    onResetPaneFit(pane.paneId);
                    setOpenMenuPane(null);
                  }}
                >
                  <span className="mv-opt-label">{t("mv.resetFit")}</span>
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
