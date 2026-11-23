import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, Update } from "@tauri-apps/plugin-updater";
import { useI18n } from "../i18n/I18nContext";
import { isTauriRuntime } from "../webFallback";

const STORAGE_AUTO_UPDATE = "shibanc-auto-update";
const STORAGE_UPDATE_REPO = "shibanc-update-repo";

function normalizeVer(raw: string): string {
  return raw.trim().replace(/^[vV]/, "");
}

function compareSemver(aRaw: string, bRaw: string): number {
  const pa = normalizeVer(aRaw)
    .split(/[-+]/)[0]
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const pb = normalizeVer(bRaw)
    .split(/[-+]/)[0]
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

function pickBestReleaseAsset(
  assets: Array<{ name: string; browser_download_url: string }>
): string | null {
  if (!assets || assets.length === 0) return null;
  const ua = navigator.userAgent.toLowerCase();
  const isWin = ua.includes("win");
  const isMac = ua.includes("mac");
  const isLinux = ua.includes("linux");

  const findExt = (exts: string[]) =>
    assets.find((a) =>
      exts.some((ext) => a.name.toLowerCase().endsWith(ext))
    )?.browser_download_url ?? null;

  if (isWin) return findExt(["-setup.exe", ".exe", ".msi"]);
  if (isMac) return findExt([".dmg", ".app.tar.gz"]);
  if (isLinux) return findExt([".appimage", ".deb", ".rpm"]);
  return assets[0]?.browser_download_url ?? null;
}

interface RemoteUpdateInfo {
  version: string;
  notes: string;
  htmlUrl: string;
  downloadUrl: string | null;
  nativeUpdate: Update | null;
}

interface VersionUpdateMenuProps {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onToast: (msg: string) => void;
}

export const VersionUpdateMenu: React.FC<VersionUpdateMenuProps> = ({
  isOpen,
  onToggle,
  onClose,
  onToast,
}) => {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;

  const [appVersion, setAppVersion] = useState<string>(() =>
    normalizeVer(typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.1.0")
  );
  const [autoCheck, setAutoCheck] = useState<boolean>(() => {
    const saved = localStorage.getItem(STORAGE_AUTO_UPDATE);
    return saved === null ? true : saved === "1";
  });
  const [repoSlug, setRepoSlug] = useState<string>(() => {
    const saved = localStorage.getItem(STORAGE_UPDATE_REPO);
    if (saved !== null) return saved;
    return typeof __GITHUB_REPO__ !== "undefined" ? __GITHUB_REPO__ : "";
  });

  const [statusKind, setStatusKind] = useState<
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "installing"
    | "upToDate"
    | "needRepo"
    | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [downloadPct, setDownloadPct] = useState<number>(0);
  const [updateInfo, setUpdateInfo] = useState<RemoteUpdateInfo | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    invoke<string>("get_app_version")
      .then((v) => {
        if (v) setAppVersion(normalizeVer(v));
      })
      .catch(() => {});
  }, []);

  const openExternal = async (url: string) => {
    if (!url.startsWith("https://")) return;
    if (isTauriRuntime()) {
      await invoke("open_external_url", { url }).catch(() => {
        window.open(url, "_blank", "noopener,noreferrer");
      });
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const runUpdateCheck = useCallback(
    async (silent = false) => {
      setStatusKind("checking");
      setErrorMsg("");

      // 1. Try native signed Tauri v2 in-app updater first when running on desktop
      if (isTauriRuntime()) {
        try {
          const nativeUpd = await check();
          if (nativeUpd) {
            const ver = normalizeVer(nativeUpd.version);
            const slug = repoSlug.trim();
            setUpdateInfo({
              version: ver,
              notes: nativeUpd.body || "",
              htmlUrl: slug ? `https://github.com/${slug}/releases/latest` : "",
              downloadUrl: null,
              nativeUpdate: nativeUpd,
            });
            setStatusKind("available");
            onToast(tRef.current("toast.updateAvailable", { ver }));
            return;
          }
          // If check() succeeded without throwing and returned null, Tauri endpoint confirmed we're up to date!
          setUpdateInfo(null);
          setStatusKind("upToDate");
          if (!silent) {
            onToast(tRef.current("toast.upToDate", { ver: appVersion }));
          }
          return;
        } catch {
          // If Tauri updater pubkey/endpoints aren't configured yet, fall back to GitHub Releases API below
        }
      }

      // 2. Fallback to GitHub Releases API (`https://api.github.com/repos/{owner}/{repo}/releases/latest`)
      const cleanRepo = repoSlug
        .trim()
        .replace(/^https?:\/\/github\.com\//i, "")
        .replace(/\.git$/i, "")
        .replace(/\/+$/, "");

      if (!cleanRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cleanRepo)) {
        setStatusKind(silent ? "idle" : "needRepo");
        return;
      }

      try {
        const resp = await fetch(
          `https://api.github.com/repos/${cleanRepo}/releases/latest`,
          {
            headers: { Accept: "application/vnd.github+json" },
          }
        );
        if (resp.status === 404) {
          setUpdateInfo(null);
          setStatusKind("upToDate");
          if (!silent) {
            onToast(tRef.current("toast.upToDate", { ver: appVersion }));
          }
          return;
        }
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const data = (await resp.json()) as {
          tag_name?: string;
          body?: string;
          html_url?: string;
          assets?: Array<{ name: string; browser_download_url: string }>;
        };
        const latestVer = normalizeVer(data.tag_name || "");
        if (latestVer && compareSemver(latestVer, appVersion) > 0) {
          const assetUrl = pickBestReleaseAsset(data.assets || []);
          setUpdateInfo({
            version: latestVer,
            notes: data.body || "",
            htmlUrl:
              data.html_url || `https://github.com/${cleanRepo}/releases/latest`,
            downloadUrl: assetUrl,
            nativeUpdate: null,
          });
          setStatusKind("available");
          onToast(tRef.current("toast.updateAvailable", { ver: latestVer }));
        } else {
          setUpdateInfo(null);
          setStatusKind("upToDate");
          if (!silent) {
            onToast(tRef.current("toast.upToDate", { ver: appVersion }));
          }
        }
      } catch (err) {
        if (silent) {
          setStatusKind("idle");
        } else {
          setErrorMsg(err instanceof Error ? err.message : String(err));
          setStatusKind("error");
        }
      }
    },
    [appVersion, onToast, repoSlug]
  );

  // Silent startup auto-check (runs once 1.8s after launch if enabled)
  const didStartupCheckRef = useRef(false);
  useEffect(() => {
    if (didStartupCheckRef.current || !autoCheck) return;
    didStartupCheckRef.current = true;
    const timer = window.setTimeout(() => {
      void runUpdateCheck(true);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [autoCheck, runUpdateCheck]);

  const handleInstallNativeUpdate = async () => {
    if (!updateInfo?.nativeUpdate) return;
    try {
      setStatusKind("downloading");
      setDownloadPct(0);
      let downloaded = 0;
      let totalLen = 0;

      await updateInfo.nativeUpdate.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          totalLen = ev.data.contentLength ?? 0;
        } else if (ev.event === "Progress") {
          downloaded += ev.data.chunkLength;
          if (totalLen > 0) {
            setDownloadPct(
              Math.min(Math.round((downloaded / totalLen) * 100), 99)
            );
          }
        } else if (ev.event === "Finished") {
          setDownloadPct(100);
        }
      });

      setStatusKind("installing");
      await relaunch();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatusKind("error");
    }
  };

  const renderStatusText = () => {
    switch (statusKind) {
      case "checking":
        return t("update.status.checking");
      case "available":
        return t("update.status.available", {
          ver: updateInfo?.version ?? appVersion,
        });
      case "downloading":
        return t("update.status.downloading", { pct: downloadPct });
      case "installing":
        return t("update.status.installing");
      case "upToDate":
        return t("update.status.upToDate", { ver: appVersion });
      case "needRepo":
        return t("update.status.needRepo");
      case "error":
        return t("update.status.error", { err: errorMsg });
      default:
        return t("update.status.idle", { ver: appVersion });
    }
  };

  const busy = statusKind === "checking" || statusKind === "downloading" || statusKind === "installing";

  return (
    <div className="popover-anchor">
      <button
        type="button"
        className={`version-pill-btn ${isOpen ? "active" : ""} ${
          updateInfo ? "has-update" : ""
        }`}
        onClick={onToggle}
        title={t("update.versionTip", { ver: appVersion })}
      >
        <span>v{appVersion}</span>
        {updateInfo && <span className="version-upd-dot" />}
      </button>

      {isOpen && (
        <div className="sh-popover update-popover">
          <div className="update-header-row">
            <span className="popover-row-title">{t("update.popoverTitle")}</span>
            <span className="sh-badge">v{appVersion}</span>
          </div>

          <div
            className={`update-status-box ${
              statusKind === "available"
                ? "available"
                : statusKind === "error" || statusKind === "needRepo"
                ? "warn"
                : ""
            }`}
          >
            <span>{renderStatusText()}</span>
            {statusKind === "downloading" && (
              <div className="update-progress-track">
                <div
                  className="update-progress-fill"
                  style={{ width: `${downloadPct}%` }}
                />
              </div>
            )}
            {updateInfo && updateInfo.notes.trim().length > 0 && (
              <div className="update-notes-preview">
                {updateInfo.notes.trim().slice(0, 220)}
              </div>
            )}
          </div>

          {/* Primary Update / Check Action */}
          {updateInfo?.nativeUpdate ? (
            <button
              type="button"
              className="sh-btn primary"
              style={{ width: "100%" }}
              disabled={busy}
              onClick={() => void handleInstallNativeUpdate()}
            >
              {t("update.installRestartBtn", { ver: updateInfo.version })}
            </button>
          ) : updateInfo ? (
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                className="sh-btn primary"
                style={{ flex: 1 }}
                onClick={() => {
                  onClose();
                  void openExternal(
                    updateInfo.downloadUrl || updateInfo.htmlUrl
                  );
                }}
              >
                {t("update.downloadInstallerBtn", { ver: updateInfo.version })}
              </button>
              {updateInfo.htmlUrl && (
                <button
                  type="button"
                  className="sh-btn"
                  onClick={() => {
                    onClose();
                    void openExternal(updateInfo.htmlUrl);
                  }}
                >
                  {t("update.viewReleaseBtn")}
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="sh-btn primary"
              style={{ width: "100%" }}
              disabled={busy}
              onClick={() => void runUpdateCheck(false)}
            >
              {t("update.checkBtn")}
            </button>
          )}

          <div className="section-divider" />

          <div className="popover-row">
            <span className="popover-row-title">{t("update.autoCheck")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={autoCheck}
              className={`sh-switch ${autoCheck ? "checked" : ""}`}
              onClick={() => {
                const next = !autoCheck;
                setAutoCheck(next);
                localStorage.setItem(STORAGE_AUTO_UPDATE, next ? "1" : "0");
              }}
            >
              <span className="sh-switch-thumb" />
            </button>
          </div>

          <div className="field-row">
            <span className="popover-row-desc">{t("update.repoLabel")}</span>
            <input
              type="text"
              className="folder-search"
              placeholder={t("update.repoPlaceholder")}
              value={repoSlug}
              onChange={(e) => {
                const val = e.target.value;
                setRepoSlug(val);
                localStorage.setItem(STORAGE_UPDATE_REPO, val.trim());
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void runUpdateCheck(false);
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
};
