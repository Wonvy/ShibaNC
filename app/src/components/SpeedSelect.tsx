import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronUp } from "lucide-react";
import { useI18n } from "../i18n/I18nContext";
import { TranslationKey } from "../i18n/locales";

export const SPEED_OPTIONS: Array<{
  keyHint: string;
  value: number;
  label: string;
  descKey: TranslationKey;
}> = [
  { keyHint: "1", value: 1, label: "1x", descKey: "speed.1" },
  { keyHint: "2", value: 2, label: "2x", descKey: "speed.2" },
  { keyHint: "3", value: 5, label: "5x", descKey: "speed.5" },
  { keyHint: "4", value: 10, label: "10x", descKey: "speed.10" },
  { keyHint: "5", value: 30, label: "30x", descKey: "speed.30" },
  { keyHint: "6", value: 100, label: "100x", descKey: "speed.100" },
];

interface SpeedSelectProps {
  value: number;
  onChange: (speed: number) => void;
}

export const SpeedSelect: React.FC<SpeedSelectProps> = ({ value, onChange }) => {
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
    SPEED_OPTIONS.find((s) => s.value === value) ?? SPEED_OPTIONS[3];

  return (
    <div className="speed-select-container" ref={wrapRef}>
      <button
        type="button"
        className={`speed-select-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={t("speed.triggerTip")}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{current.label}</span>
        <ChevronUp size={12} className={`dd-chevron ${open ? "rotated" : ""}`} />
      </button>

      {open && (
        <div className="sh-dropdown-menu upward speed-menu" role="listbox">
          <div className="sh-dropdown-label">{t("speed.menuTitle")}</div>
          {SPEED_OPTIONS.map((opt) => {
            const selected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={`sh-dropdown-item compact ${selected ? "selected" : ""}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <kbd className="speed-kbd">{opt.keyHint}</kbd>
                <span className="speed-opt-val">{opt.label}</span>
                <span className="speed-opt-desc">{t(opt.descKey)}</span>
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
