import React, { useEffect, useRef, useState } from "react";
import { LocateFixed, X } from "lucide-react";
import { useI18n } from "../i18n/I18nContext";

const ROW_HEIGHT = 22;
const OVERSCAN = 14;

interface GcodePanelProps {
  lines: string[];
  totalLines: number;
  currentLine: number;
  width: number;
  onSelectLine: (lineNumber: number) => void;
  onClose: () => void;
}

export const GcodePanel: React.FC<GcodePanelProps> = ({
  lines,
  totalLines,
  currentLine,
  width,
  onSelectLine,
  onClose,
}) => {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState<number>(0);
  const [viewportH, setViewportH] = useState<number>(600);
  const programmaticScrollRef = useRef<boolean>(false);

  // Measure panel height with ResizeObserver
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight || 600);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportH(entry.contentRect.height || 600);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-scroll scrollbar whenever currentLine changes from timeline / playback
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || lines.length === 0) return;
    const clampedIdx = Math.min(Math.max(currentLine - 1, 0), lines.length - 1);
    const targetRowTop = clampedIdx * ROW_HEIGHT;
    const viewH = el.clientHeight || viewportH;
    const maxScroll = Math.max(lines.length * ROW_HEIGHT - viewH, 0);

    // Keep the active G-code row centered at ~40% from top of the viewport
    const desiredTop = Math.min(
      Math.max(targetRowTop - viewH * 0.4, 0),
      maxScroll
    );

    programmaticScrollRef.current = true;
    el.scrollTop = desiredTop;
    setScrollTop(desiredTop);
  }, [currentLine, lines.length, viewportH]);

  const scrollToActiveNow = () => {
    const el = scrollRef.current;
    if (!el || lines.length === 0) return;
    const clampedIdx = Math.min(Math.max(currentLine - 1, 0), lines.length - 1);
    const viewH = el.clientHeight || viewportH;
    const maxScroll = Math.max(lines.length * ROW_HEIGHT - viewH, 0);
    const desiredTop = Math.min(
      Math.max(clampedIdx * ROW_HEIGHT - viewH * 0.4, 0),
      maxScroll
    );
    el.scrollTop = desiredTop;
    setScrollTop(desiredTop);
  };

  const count = lines.length;
  const totalHeight = count * ROW_HEIGHT;
  const startIdx = Math.max(Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN, 0);
  const visibleCount = Math.ceil(viewportH / ROW_HEIGHT) + OVERSCAN * 2;
  const endIdx = Math.min(startIdx + visibleCount, count);

  return (
    <aside className="right-gcode-panel" style={{ width }}>
      <div className="gcode-header">
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span>{t("gcode.title")}</span>
          <span
            className="gcode-cur-badge"
            onClick={scrollToActiveNow}
            title={t("gcode.centerTip")}
          >
            {t("gcode.lineBadge", {
              cur: currentLine.toLocaleString(),
              total: totalLines.toLocaleString(),
            })}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <button
            type="button"
            className="sh-btn ghost icon-only"
            style={{ width: 24, height: 24 }}
            onClick={scrollToActiveNow}
            title={t("gcode.locateTip")}
          >
            <LocateFixed size={13} />
          </button>
          <button
            type="button"
            className="sh-btn ghost icon-only"
            style={{ width: 24, height: 24 }}
            onClick={onClose}
            title={t("gcode.closeTip")}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div
        className="gcode-list"
        ref={scrollRef}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          programmaticScrollRef.current = false;
        }}
      >
        <div style={{ height: totalHeight, position: "relative", width: "100%" }}>
          {lines.slice(startIdx, endIdx).map((ln, offset) => {
            const idx = startIdx + offset;
            const lineNum = idx + 1;
            const isCur = lineNum === currentLine;
            const isPast = lineNum < currentLine;
            const trimmed = ln.trimStart();
            const isRapid = /^G0*0(\s|$)/i.test(trimmed);
            const isComment = trimmed.startsWith("(") || trimmed.startsWith(";");

            return (
              <div
                key={lineNum}
                className={`gcode-line ${isCur ? "current" : isPast ? "past" : ""} ${
                  isRapid ? "rapid-ln" : isComment ? "comment-ln" : ""
                }`}
                style={{
                  position: "absolute",
                  top: idx * ROW_HEIGHT,
                  left: 0,
                  right: 0,
                  height: ROW_HEIGHT,
                }}
                onClick={() => onSelectLine(lineNum)}
              >
                <span className="ln-marker">{isCur ? "▶" : ""}</span>
                <span className="ln-num">{lineNum}</span>
                <span className="ln-code">{ln}</span>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
};
