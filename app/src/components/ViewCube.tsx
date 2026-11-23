import React, { useRef, useState } from "react";
import { Home } from "lucide-react";
import { TranslateFn, useI18n } from "../i18n/I18nContext";
import { TranslationKey } from "../i18n/locales";

interface ViewCubeProps {
  yawDeg: number;
  pitchDeg: number;
  isOrtho: boolean;
  onOrbitDelta: (dYaw: number, dPitch: number) => void;
  onSelectOrientation: (
    yawDeg: number,
    pitchDeg: number,
    resetPanZoom?: boolean,
    ortho?: boolean
  ) => void;
  onToggleOrtho: () => void;
}

const CUBE_HALF = 29; // 58px crisp CAD ViewCube
const ISO_PITCH = 35.26439; // atan(1 / sqrt(2)) exact isometric elevation

type CornerPos = "tl" | "tr" | "bl" | "br";

interface FaceDef {
  id: string;
  labelKey: TranslationKey;
  tone: "top" | "side" | "bottom";
  yaw: number;
  pitch: number;
  transform: string;
  mapCorner: (du: -1 | 1, dv: -1 | 1) => [number, number, number];
}

const FACES: FaceDef[] = [
  {
    id: "top",
    labelKey: "viewcube.face.top",
    tone: "top",
    yaw: 0,
    pitch: 89.2,
    transform: `translateZ(${CUBE_HALF}px)`,
    mapCorner: (du, dv) => [du, dv, 1],
  },
  {
    id: "bottom",
    labelKey: "viewcube.face.bottom",
    tone: "bottom",
    yaw: 0,
    pitch: -89.2,
    transform: `rotateX(180deg) translateZ(${CUBE_HALF}px)`,
    mapCorner: (du, dv) => [du, -dv, -1],
  },
  {
    id: "front",
    labelKey: "viewcube.face.front",
    tone: "side",
    yaw: 0,
    pitch: 0,
    transform: `rotateX(-90deg) translateZ(${CUBE_HALF}px)`,
    mapCorner: (du, dv) => [du, 1, -dv],
  },
  {
    id: "back",
    labelKey: "viewcube.face.back",
    tone: "side",
    yaw: 180,
    pitch: 0,
    transform: `rotateZ(180deg) rotateX(-90deg) translateZ(${CUBE_HALF}px)`,
    mapCorner: (du, dv) => [-du, -1, -dv],
  },
  {
    id: "right",
    labelKey: "viewcube.face.right",
    tone: "side",
    yaw: 90,
    pitch: 0,
    transform: `rotateZ(-90deg) rotateX(-90deg) translateZ(${CUBE_HALF}px)`,
    mapCorner: (du, dv) => [1, -du, -dv],
  },
  {
    id: "left",
    labelKey: "viewcube.face.left",
    tone: "side",
    yaw: -90,
    pitch: 0,
    transform: `rotateZ(90deg) rotateX(-90deg) translateZ(${CUBE_HALF}px)`,
    mapCorner: (du, dv) => [-1, du, -dv],
  },
];

const CORNERS: Array<{ cls: CornerPos; du: -1 | 1; dv: -1 | 1 }> = [
  { cls: "tl", du: -1, dv: -1 },
  { cls: "tr", du: 1, dv: -1 },
  { cls: "bl", du: -1, dv: 1 },
  { cls: "br", du: 1, dv: 1 },
];

function vertexInfo(sx: number, sy: number, sz: number, t: TranslateFn) {
  const yaw = (Math.atan2(sx, sy) * 180) / Math.PI;
  const pitch = sz > 0 ? ISO_PITCH : -ISO_PITCH;
  const key = `${sx},${sy},${sz}`;
  const title = t("viewcube.vertexTip", {
    x: sx < 0 ? t("viewcube.face.left") : t("viewcube.face.right"),
    y: sy > 0 ? t("viewcube.face.front") : t("viewcube.face.back"),
    z: sz > 0 ? t("viewcube.face.top") : t("viewcube.face.bottom"),
  });
  return { yaw, pitch, key, title };
}

export const ViewCube: React.FC<ViewCubeProps> = ({
  yawDeg,
  pitchDeg,
  isOrtho,
  onOrbitDelta,
  onSelectOrientation,
  onToggleOrtho,
}) => {
  const { t } = useI18n();
  const [hoverVKey, setHoverVKey] = useState<string | null>(null);

  const dragState = useRef<{
    down: boolean;
    moved: boolean;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    snapTarget: { yaw: number; pitch: number; ortho: boolean } | null;
  }>({
    down: false,
    moved: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    snapTarget: null,
  });

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    // Capture nearest hotspot (corner vertex takes priority over parent face!) before setPointerCapture
    const hitEl = (e.target as HTMLElement).closest<HTMLElement>("[data-vc-yaw]");
    const snapTarget = hitEl
      ? {
          yaw: Number(hitEl.dataset.vcYaw),
          pitch: Number(hitEl.dataset.vcPitch),
          ortho: hitEl.dataset.vcOrtho === "1",
        }
      : null;

    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = {
      down: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      snapTarget,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current.down) return;
    const dx = e.clientX - dragState.current.lastX;
    const dy = e.clientY - dragState.current.lastY;
    if (
      Math.hypot(
        e.clientX - dragState.current.startX,
        e.clientY - dragState.current.startY
      ) > 3
    ) {
      dragState.current.moved = true;
    }
    dragState.current.lastX = e.clientX;
    dragState.current.lastY = e.clientY;
    if (dragState.current.moved) {
      onOrbitDelta(-dx * 0.65, dy * 0.65);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const wasDown = dragState.current.down;
    const moved = dragState.current.moved;
    const target = dragState.current.snapTarget;
    dragState.current.down = false;
    dragState.current.snapTarget = null;

    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (wasDown && !moved && target) {
      onSelectOrientation(target.yaw, target.pitch, false, target.ortho);
    }
  };

  const cubeTransform = `rotateX(${90 - pitchDeg}deg) rotateZ(${yawDeg}deg)`;

  return (
    <div
      className="viewcube-widget"
      onPointerLeave={() => setHoverVKey(null)}
    >
      <button
        type="button"
        className="vc-home-btn"
        onClick={() => onSelectOrientation(-35, 47, true, false)}
        title={t("viewcube.homeTip")}
      >
        <Home size={13} />
      </button>

      <div
        className="viewcube-scene"
        style={{ perspective: isOrtho ? "none" : "320px" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div className="viewcube-box" style={{ transform: cubeTransform }}>
          {FACES.map((face) => {
            const label = t(face.labelKey);
            const isAsciiLong = /^[A-Za-z0-9.\s-]{3,}$/.test(label);
            return (
              <div
                key={face.id}
                className={`vc-face vc-tone-${face.tone} ${
                  hoverVKey ? "suppress-face-hover" : ""
                }`}
                data-vc-yaw={face.yaw}
                data-vc-pitch={face.pitch}
                data-vc-ortho="1"
                style={{ transform: face.transform }}
                title={t("viewcube.faceTip", { face: label })}
              >
                <span
                  className={`vc-face-label ${isAsciiLong ? "ascii-word" : ""}`}
                >
                  {label}
                </span>

                {/* 4 Clickable Isometric Cube Vertices on each face */}
                {CORNERS.map((c) => {
                  const [sx, sy, sz] = face.mapCorner(c.du, c.dv);
                  const v = vertexInfo(sx, sy, sz, t);
                  const active = hoverVKey === v.key;
                  return (
                    <span
                      key={c.cls}
                      className={`vc-corner vc-corner-${c.cls} ${
                        active ? "v-active" : ""
                      }`}
                      data-vc-yaw={v.yaw}
                      data-vc-pitch={v.pitch}
                      data-vc-ortho="1"
                      title={v.title}
                      onPointerEnter={() => setHoverVKey(v.key)}
                      onPointerLeave={() =>
                        setHoverVKey((prev) => (prev === v.key ? null : prev))
                      }
                    />
                  );
                })}
              </div>
            );
          })}

          {/* CNC Origin X(Red) / Y(Green) / Z(Blue) Triad */}
          <div
            className="vc-axis vc-axis-x"
            style={{
              transform: `translate3d(${-CUBE_HALF}px, ${CUBE_HALF + 1}px, ${-CUBE_HALF - 1}px)`,
            }}
          />
          <div
            className="vc-axis vc-axis-y"
            style={{
              transform: `translate3d(${-CUBE_HALF - 1}px, ${CUBE_HALF}px, ${-CUBE_HALF - 1}px) rotateZ(-90deg)`,
            }}
          />
          <div
            className="vc-axis vc-axis-z"
            style={{
              transform: `translate3d(${-CUBE_HALF - 1}px, ${CUBE_HALF + 1}px, ${-CUBE_HALF}px) rotateY(-90deg)`,
            }}
          />
        </div>
      </div>

      <button
        type="button"
        className={`vc-proj-pill ${isOrtho ? "ortho" : ""}`}
        onClick={onToggleOrtho}
        title={t("viewcube.projTip")}
      >
        {isOrtho ? t("viewcube.ortho") : t("viewcube.persp")}
      </button>
    </div>
  );
};
