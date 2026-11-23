import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LayoutGrid, List } from "lucide-react";
import { useI18n } from "../i18n/I18nContext";
import { TranslationKey } from "../i18n/locales";
import { FolderFileItem } from "../types";
import { WebGpuViewport } from "../gpu/WebGpuViewport";
import {
  generateWebSampleText,
  isTauriRuntime,
  parseGcodeInBrowser,
} from "../webFallback";

interface FileExplorerPaneProps {
  folderFiles: FolderFileItem[];
  activeFileKey: string;
  currentFileName?: string;
  folderFilter: string;
  darkMode: boolean;
  viewport: WebGpuViewport | null;
  onChangeFilter: (val: string) => void;
  onClearFiles: () => void;
  onOpenFileDialog: () => void;
  onOpenFolderDialog: () => void;
  onSelectFolderItem: (item: FolderFileItem) => void;
  onSelectBuiltinSample: (kind: "relief_tap" | "mechanical_nc") => void;
}

// Persistent across tab switches & StrictMode double-mounts
const GLOBAL_THUMB_CACHE = new Map<string, string>();
const GLOBAL_INFLIGHT = new Map<string, Promise<string>>();

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const BUILTIN_ITEMS: Array<{
  kind: "relief_tap" | "mechanical_nc";
  key: string;
  name: string;
  subKey: TranslationKey;
  ext: string;
}> = [
  {
    kind: "relief_tap",
    key: "builtin:relief_tap",
    name: "lotus_relief_medallion.tap",
    subKey: "files.sample.reliefSub",
    ext: "tap",
  },
  {
    kind: "mechanical_nc",
    key: "builtin:mechanical_nc",
    name: "aerospace_bearing_housing.nc",
    subKey: "files.sample.mechSub",
    ext: "nc",
  },
];

export const FileExplorerPane: React.FC<FileExplorerPaneProps> = ({
  folderFiles,
  activeFileKey,
  currentFileName,
  folderFilter,
  darkMode,
  viewport,
  onChangeFilter,
  onClearFiles,
  onOpenFileDialog,
  onOpenFolderDialog,
  onSelectFolderItem,
  onSelectBuiltinSample,
}) => {
  const { t } = useI18n();
  const [displayMode, setDisplayMode] = useState<"card" | "list">(() => {
    const saved = localStorage.getItem("shibanc-files-mode");
    return saved === "list" ? "list" : "card";
  });

  const [, setThumbTick] = useState<number>(0);
  const mountedRef = useRef<boolean>(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const switchMode = (m: "card" | "list") => {
    setDisplayMode(m);
    localStorage.setItem("shibanc-files-mode", m);
  };

  const themeTag = darkMode ? "dark" : "light";

  // Queue & cache 3D Studio Preview Thumbnails without StrictMode cancellation races
  useEffect(() => {
    if (displayMode !== "card" || !viewport) return;

    const ensureThumb = (cacheKey: string, factory: () => Promise<string>) => {
      if (GLOBAL_THUMB_CACHE.has(cacheKey)) return;
      let existing = GLOBAL_INFLIGHT.get(cacheKey);
      if (!existing) {
        existing = factory()
          .then((url) => {
            if (url) {
              GLOBAL_THUMB_CACHE.set(cacheKey, url);
            }
            return url;
          })
          .catch(() => "")
          .finally(() => {
            GLOBAL_INFLIGHT.delete(cacheKey);
          });
        GLOBAL_INFLIGHT.set(cacheKey, existing);
      }
      void existing.then((url) => {
        if (url && mountedRef.current) {
          setThumbTick((t) => t + 1);
        }
      });
    };

    // 1. Built-in samples
    for (const b of BUILTIN_ITEMS) {
      const cacheKey = `${b.key}|${themeTag}`;
      ensureThumb(cacheKey, async () => {
        const sample = generateWebSampleText(b.kind);
        const parsed = parseGcodeInBrowser(sample.text, sample.name, sample.ext);
        return viewport.renderThumbnailDataUrl(
          parsed.segmentsBuffer,
          parsed.dto.stock,
          parsed.dto.tool,
          parsed.dto.default_material_id,
          darkMode
        );
      });
    }

    // 2. Imported files
    const visibleFolder = folderFiles
      .filter((it) =>
        !folderFilter.trim()
          ? true
          : it.name.toLowerCase().includes(folderFilter.trim().toLowerCase())
      )
      .slice(0, 48);

    for (const item of visibleFolder) {
      const cacheKey = `${item.path}|${themeTag}`;
      ensureThumb(cacheKey, async () => {
        if (item.browserFile) {
          const text = await item.browserFile.text();
          const parsed = parseGcodeInBrowser(text, item.name, item.ext);
          return viewport.renderThumbnailDataUrl(
            parsed.segmentsBuffer,
            parsed.dto.stock,
            parsed.dto.tool,
            parsed.dto.default_material_id,
            darkMode
          );
        }
        if (isTauriRuntime()) {
          const pngBuf = await invoke<ArrayBuffer>("render_gcode_card_png", {
            path: item.path,
            darkMode,
          });
          const blob = new Blob([pngBuf], { type: "image/png" });
          return URL.createObjectURL(blob);
        }
        return "";
      });
    }
  }, [displayMode, viewport, folderFiles, folderFilter, darkMode, themeTag]);

  const filteredFiles = folderFiles.filter((item) =>
    !folderFilter.trim()
      ? true
      : item.name.toLowerCase().includes(folderFilter.trim().toLowerCase())
  );

  const filteredBuiltins = BUILTIN_ITEMS.filter((b) =>
    !folderFilter.trim()
      ? true
      : b.name.toLowerCase().includes(folderFilter.trim().toLowerCase()) ||
        t(b.subKey).toLowerCase().includes(folderFilter.trim().toLowerCase())
  );

  return (
    <div className="sidebar-files-pane">
      {/* Compact Action & View Mode Switcher Row */}
      <div className="files-toolbar-row">
        <button
          type="button"
          className="sh-btn primary files-open-btn"
          onClick={onOpenFileDialog}
          title={t("files.openFileTip")}
        >
          {t("files.openFile")}
        </button>
        <button
          type="button"
          className="sh-btn files-open-btn"
          onClick={onOpenFolderDialog}
          title={t("files.openFolderTip")}
        >
          {t("files.openFolder")}
        </button>

        <div
          className="sh-tabs files-mode-switch"
          role="group"
          aria-label={t("files.viewSwitchAria")}
        >
          <button
            type="button"
            className={`sh-tab icon-tab ${displayMode === "card" ? "active" : ""}`}
            onClick={() => switchMode("card")}
            title={t("files.cardViewTip")}
          >
            <LayoutGrid size={13} />
          </button>
          <button
            type="button"
            className={`sh-tab icon-tab ${displayMode === "list" ? "active" : ""}`}
            onClick={() => switchMode("list")}
            title={t("files.listViewTip")}
          >
            <List size={13} />
          </button>
        </div>
      </div>

      {/* Search & Clear Row */}
      {(folderFiles.length > 0 || folderFilter.trim().length > 0) && (
        <div className="files-filter-row">
          <input
            type="text"
            className="folder-search"
            placeholder={t("files.searchPlaceholder")}
            value={folderFilter}
            onChange={(e) => onChangeFilter(e.target.value)}
          />
          {folderFiles.length > 0 && (
            <button
              type="button"
              className="sh-btn ghost"
              style={{ height: 28, padding: "0 7px", flexShrink: 0 }}
              onClick={onClearFiles}
              title={t("files.clearTip")}
            >
              {t("files.clear")}
            </button>
          )}
        </div>
      )}

      {/* Scrollable Card or List Container */}
      <div className="sidebar-file-list">
        {filteredFiles.length > 0 && (
          <div className={displayMode === "card" ? "nc-card-grid" : "file-group-section"}>
            {filteredFiles.map((item) => {
              const isCurrent =
                activeFileKey === item.path || currentFileName === item.name;
              const sizeStr = formatBytes(item.size_bytes);
              const thumbUrl = GLOBAL_THUMB_CACHE.get(`${item.path}|${themeTag}`);

              if (displayMode === "card") {
                return (
                  <button
                    key={item.path}
                    type="button"
                    className={`nc-preview-card ${isCurrent ? "active" : ""}`}
                    title={item.path}
                    onClick={() => onSelectFolderItem(item)}
                  >
                    <div className="nc-card-thumb">
                      {thumbUrl ? (
                        <img src={thumbUrl} alt={item.name} loading="lazy" />
                      ) : (
                        <span className="nc-thumb-placeholder">
                          {t("files.renderingThumb")}
                        </span>
                      )}
                      <span className="nc-card-ext">{item.ext}</span>
                    </div>
                    <div className="nc-card-footer">
                      <span className="nc-file-name">{item.name}</span>
                      {sizeStr && <span className="nc-file-sub">{sizeStr}</span>}
                    </div>
                  </button>
                );
              }

              return (
                <button
                  key={item.path}
                  type="button"
                  className={`nc-file-item ${isCurrent ? "active" : ""}`}
                  title={item.path}
                  onClick={() => onSelectFolderItem(item)}
                >
                  <div className="nc-file-meta">
                    <span className="nc-file-name">{item.name}</span>
                    {sizeStr && <span className="nc-file-sub">{sizeStr}</span>}
                  </div>
                  <span className="ext-tag">{item.ext}</span>
                </button>
              );
            })}
          </div>
        )}

        {filteredBuiltins.length > 0 && (
          <div className="file-group-section">
            <div className="file-group-caption">{t("files.builtinGroup")}</div>
            <div className={displayMode === "card" ? "nc-card-grid" : "file-group-section"}>
              {filteredBuiltins.map((b) => {
                const isCurrent =
                  activeFileKey === b.key || currentFileName === b.name;
                const thumbUrl = GLOBAL_THUMB_CACHE.get(`${b.key}|${themeTag}`);

                if (displayMode === "card") {
                  return (
                    <button
                      key={b.key}
                      type="button"
                      className={`nc-preview-card ${isCurrent ? "active" : ""}`}
                      onClick={() => onSelectBuiltinSample(b.kind)}
                    >
                      <div className="nc-card-thumb">
                        {thumbUrl ? (
                          <img src={thumbUrl} alt={b.name} />
                        ) : (
                          <span className="nc-thumb-placeholder">
                            {t("files.renderingShort")}
                          </span>
                        )}
                        <span className="nc-card-ext">{b.ext}</span>
                      </div>
                      <div className="nc-card-footer">
                        <span className="nc-file-name">{b.name}</span>
                        <span className="nc-file-sub">{t(b.subKey)}</span>
                      </div>
                    </button>
                  );
                }

                return (
                  <button
                    key={b.key}
                    type="button"
                    className={`nc-file-item ${isCurrent ? "active" : ""}`}
                    onClick={() => onSelectBuiltinSample(b.kind)}
                  >
                    <div className="nc-file-meta">
                      <span className="nc-file-name">{b.name}</span>
                      <span className="nc-file-sub">{t(b.subKey)}</span>
                    </div>
                    <span className="ext-tag">{b.ext}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="files-drop-hint">{t("files.dropHint")}</div>
      </div>
    </div>
  );
};
