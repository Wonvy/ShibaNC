import React, { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Check, X } from "lucide-react";
import { useI18n } from "../i18n/I18nContext";
import { isTauriRuntime } from "../webFallback";

interface LanguageMenuProps {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onToast: (msg: string) => void;
}

export const LanguageMenu: React.FC<LanguageMenuProps> = ({
  isOpen,
  onToggle,
  onClose,
  onToast,
}) => {
  const {
    locale,
    activePack,
    locales,
    t,
    setLocale,
    exportCurrentLocale,
    importLocaleText,
    removeCustomLocale,
  } = useI18n();

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const builtins = locales.filter((l) => l.builtin);
  const customs = locales.filter((l) => !l.builtin);

  const handleExport = async () => {
    onClose();
    const { fileName, jsonText } = exportCurrentLocale();

    if (isTauriRuntime()) {
      try {
        const target = await save({
          defaultPath: fileName,
          filters: [{ name: t("dialog.filterJson"), extensions: ["json"] }],
        });
        if (!target) return;
        await invoke("save_text_file", { path: target, content: jsonText });
        onToast(t("toast.langExported", { name: target }));
      } catch (err) {
        onToast(t("toast.exportError", { err: String(err) }));
      }
      return;
    }

    const blob = new Blob([jsonText], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    onToast(t("toast.langExported", { name: fileName }));
  };

  const handleImportClick = async () => {
    if (isTauriRuntime()) {
      onClose();
      try {
        const selected = await open({
          multiple: false,
          filters: [{ name: t("dialog.filterJson"), extensions: ["json"] }],
        });
        if (typeof selected === "string" && selected) {
          const raw = await invoke<string>("read_text_file", { path: selected });
          const fileName = selected.split(/[\\/]/).pop() || "custom.json";
          const res = importLocaleText(raw, fileName);
          onToast(
            t("toast.langImported", {
              name: res.pack.name,
              count: res.keyCount,
            })
          );
        }
      } catch (err) {
        onToast(t("toast.langImportError", { err: String(err) }));
      }
      return;
    }

    fileInputRef.current?.click();
  };

  return (
    <div className="popover-anchor">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.currentTarget.value = "";
          if (!f) return;
          onClose();
          try {
            const raw = await f.text();
            const res = importLocaleText(raw, f.name);
            onToast(
              t("toast.langImported", {
                name: res.pack.name,
                count: res.keyCount,
              })
            );
          } catch (err) {
            onToast(t("toast.langImportError", { err: String(err) }));
          }
        }}
      />

      <button
        type="button"
        className={`sh-btn ghost lang-trigger-btn ${isOpen ? "active" : ""}`}
        onClick={onToggle}
        title={t("topbar.langTip")}
      >
        {activePack.shortLabel}
      </button>

      {isOpen && (
        <div className="sh-dropdown-menu lang-menu" role="menu">
          <div className="sh-dropdown-label">{t("topbar.lang.menuTitle")}</div>
          {builtins.map((item) => {
            const selected = item.code === locale;
            return (
              <button
                key={item.code}
                type="button"
                className={`sh-dropdown-item compact ${selected ? "selected" : ""}`}
                onClick={() => {
                  setLocale(item.code);
                  onClose();
                }}
              >
                <span className="lang-code-pill">{item.shortLabel}</span>
                <span className="lang-opt-name">{item.name}</span>
                {selected && (
                  <span className="sh-check-badge">
                    <Check size={10} strokeWidth={2.6} />
                  </span>
                )}
              </button>
            );
          })}

          {customs.length > 0 && (
            <>
              <div className="section-divider" style={{ margin: "3px 4px" }} />
              <div className="sh-dropdown-label">
                {t("topbar.lang.customSection")}
              </div>
              {customs.map((item) => {
                const selected = item.code === locale;
                return (
                  <div
                    key={item.code}
                    className={`sh-dropdown-item compact lang-custom-row ${
                      selected ? "selected" : ""
                    }`}
                    onClick={() => {
                      setLocale(item.code);
                      onClose();
                    }}
                  >
                    <span className="lang-code-pill">{item.shortLabel}</span>
                    <span className="lang-opt-name">{item.name}</span>
                    {selected && (
                      <span className="sh-check-badge">
                        <Check size={10} strokeWidth={2.6} />
                      </span>
                    )}
                    <button
                      type="button"
                      className="lang-remove-btn"
                      title={t("topbar.lang.removeTip")}
                      onClick={(e) => {
                        e.stopPropagation();
                        const removed = removeCustomLocale(item.code);
                        if (removed) {
                          onToast(t("toast.langRemoved", { name: removed.name }));
                        }
                      }}
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
            </>
          )}

          <div className="section-divider" style={{ margin: "4px 4px" }} />

          <button
            type="button"
            className="sh-dropdown-item"
            onClick={() => void handleImportClick()}
          >
            <div className="tool-opt-meta">
              <span className="tool-opt-title">{t("topbar.lang.import")}</span>
              <span className="tool-opt-desc">{t("topbar.lang.importDesc")}</span>
            </div>
          </button>

          <button
            type="button"
            className="sh-dropdown-item"
            onClick={() => void handleExport()}
          >
            <div className="tool-opt-meta">
              <span className="tool-opt-title">{t("topbar.lang.export")}</span>
              <span className="tool-opt-desc">{t("topbar.lang.exportDesc")}</span>
            </div>
          </button>
        </div>
      )}
    </div>
  );
};
