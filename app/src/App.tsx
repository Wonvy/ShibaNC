import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ChevronLeft,
  ChevronRight,
  Moon,
  Pause,
  Play,
  RotateCcw,
  Sun,
  X,
} from "lucide-react";
import {
  CameraState,
  FolderFileItem,
  ProgramPayloadDto,
  SegmentTipInfo,
  ShadersDto,
  StockSpec,
  TOOL_KIND_CODE,
  ToolSpec,
} from "./types";
import { WebGpuViewport } from "./gpu/WebGpuViewport";
import {
  lookAtRh,
  mulMat4,
  orthoRhZeroToOne,
  perspectiveRhZeroToOne,
  projectPointToCss,
} from "./gpu/math";
import { FileExplorerPane } from "./components/FileExplorerPane";
import { GcodePanel } from "./components/GcodePanel";
import { LanguageMenu } from "./components/LanguageMenu";
import { MaterialSelect } from "./components/MaterialSelect";
import { MeasureOverlay, MeasurementPair } from "./components/MeasureOverlay";
import {
  AuxPaneState,
  buildActivePanes,
  createDefaultAuxPanes,
  MultiViewOverlay,
  PaneDescriptor,
  PanePresetOption,
  ViewportLayoutMode,
} from "./components/MultiViewOverlay";
import { SPEED_OPTIONS, SpeedSelect } from "./components/SpeedSelect";
import { StockDiagram } from "./components/StockDiagram";
import { ToolSelect } from "./components/ToolSelect";
import { ViewCube } from "./components/ViewCube";
import { useI18n } from "./i18n/I18nContext";
import {
  generateWebSampleText,
  getWebShaders,
  isTauriRuntime,
  parseGcodeInBrowser,
} from "./webFallback";

const DEFAULT_CAMERA: CameraState = {
  yawDeg: -35,
  pitchDeg: 47,
  zoom: 1.05,
  panX: 0,
  panY: 0,
  panZ: 0,
  ortho: false,
};

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0s";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m >= 60) {
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function panCameraInPlane(
  c: CameraState,
  dxCss: number,
  dyCss: number,
  paneCssW: number,
  paneCssH: number,
  radius: number
): CameraState {
  const aspect = Math.max(paneCssW, 1) / Math.max(paneCssH, 1);
  const fitFactor = aspect < 1.0 ? 1.0 / aspect : 1.0;
  const halfH = (radius * 1.18 * fitFactor) / Math.max(c.zoom, 0.15);
  const worldPerPx = (2.0 * halfH) / Math.max(paneCssH, 1);

  const yaw = (c.yawDeg * Math.PI) / 180.0;
  const pitch = (Math.min(Math.max(c.pitchDeg, -89.2), 89.2) * Math.PI) / 180.0;

  const sx = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const ux = -Math.sin(yaw) * Math.sin(pitch);
  const uy = Math.cos(yaw) * Math.sin(pitch);
  const uz = Math.cos(pitch);

  return {
    ...c,
    panX: c.panX + (-dxCss * sx + dyCss * ux) * worldPerPx,
    panY: c.panY + (-dxCss * sy + dyCss * uy) * worldPerPx,
    panZ: c.panZ + dyCss * uz * worldPerPx,
  };
}

interface NumericSliderProps {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  sliderMin: number;
  sliderMax: number;
  step: number;
  decimals?: number;
  onChange: (val: number) => void;
}

const NumericSliderField: React.FC<NumericSliderProps> = ({
  label,
  unit,
  value,
  min,
  max,
  sliderMin,
  sliderMax,
  step,
  decimals = 3,
  onChange,
}) => {
  const formatVal = useCallback(
    (v: number) => {
      const fixed = v.toFixed(decimals);
      return decimals > 1
        ? fixed.replace(/\.?0+$/, (m) => (m === "." ? "" : "")) || fixed
        : fixed;
    },
    [decimals]
  );

  const [draft, setDraft] = useState<string>(() => formatVal(value));
  const focusedRef = useRef<boolean>(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(formatVal(value));
    }
  }, [value, formatVal]);

  const commitDraft = (raw: string) => {
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed)) {
      const clamped = Math.min(Math.max(parsed, min), max);
      onChange(clamped);
      setDraft(formatVal(clamped));
    } else {
      setDraft(formatVal(value));
    }
  };

  return (
    <div className="field-row">
      <div className="field-label">
        <span>{label}</span>
        <div className="num-input-wrap">
          <input
            type="text"
            inputMode="decimal"
            className="num-input"
            value={draft}
            onFocus={(e) => {
              focusedRef.current = true;
              e.currentTarget.select();
            }}
            onChange={(e) => {
              const txt = e.target.value;
              setDraft(txt);
              const parsed = parseFloat(txt);
              if (Number.isFinite(parsed) && parsed >= min && parsed <= max) {
                onChange(parsed);
              }
            }}
            onBlur={(e) => {
              focusedRef.current = false;
              commitDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
          />
          <span className="unit-label">{unit}</span>
        </div>
      </div>
      <input
        type="range"
        className="range-input"
        min={sliderMin}
        max={sliderMax}
        step={step}
        value={Math.min(Math.max(value, sliderMin), sliderMax)}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          onChange(v);
          if (!focusedRef.current) {
            setDraft(formatVal(v));
          }
        }}
      />
    </div>
  );
};

interface CompactDimInputProps {
  axisLabel: string;
  value: number;
  min: number;
  max: number;
  decimals?: number;
  onChange: (val: number) => void;
}

const CompactDimInput: React.FC<CompactDimInputProps> = ({
  axisLabel,
  value,
  min,
  max,
  decimals = 1,
  onChange,
}) => {
  const formatVal = useCallback(
    (v: number) => {
      const fixed = v.toFixed(decimals);
      return fixed.replace(/\.0+$/, "");
    },
    [decimals]
  );

  const [draft, setDraft] = useState<string>(() => formatVal(value));
  const focusedRef = useRef<boolean>(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(formatVal(value));
    }
  }, [value, formatVal]);

  const commit = (raw: string) => {
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed)) {
      const clamped = Math.min(Math.max(parsed, min), max);
      onChange(clamped);
      setDraft(formatVal(clamped));
    } else {
      setDraft(formatVal(value));
    }
  };

  return (
    <div className="dim-cell">
      <span className="dim-cell-label">{axisLabel}</span>
      <div className="dim-input-box">
        <input
          type="text"
          inputMode="decimal"
          className="num-input"
          value={draft}
          onFocus={(e) => {
            focusedRef.current = true;
            e.currentTarget.select();
          }}
          onChange={(e) => {
            const txt = e.target.value;
            setDraft(txt);
            const parsed = parseFloat(txt);
            if (Number.isFinite(parsed) && parsed >= min && parsed <= max) {
              onChange(parsed);
            }
          }}
          onBlur={(e) => {
            focusedRef.current = false;
            commit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
        />
        <span className="dim-suffix">mm</span>
      </div>
    </div>
  );
};

export const App: React.FC = () => {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;

  const topbarRef = useRef<HTMLElement | null>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const vpRef = useRef<WebGpuViewport | null>(null);
  const webFileInputRef = useRef<HTMLInputElement | null>(null);
  const webFolderInputRef = useRef<HTMLInputElement | null>(null);
  const tweenRafRef = useRef<number>(0);
  const cutterTweenRafRef = useRef<number>(0);
  const renderRafRef = useRef<number>(0);
  const asyncRedrawRef = useRef<() => void>(() => {});

  // Resizable Left & Right panel widths
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("shibanc-left-w"));
    return Number.isFinite(v) && v >= 210 && v <= 480 ? v : 272;
  });
  const [rightWidth, setRightWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("shibanc-right-w"));
    return Number.isFinite(v) && v >= 220 && v <= 560 ? v : 292;
  });
  const [resizingSide, setResizingSide] = useState<"left" | "right" | null>(null);

  // Left Sidebar Tabs ("params" | "files") & Loaded Toolpath Files
  const [leftTab, setLeftTab] = useState<"params" | "files">("params");
  const [folderFiles, setFolderFiles] = useState<FolderFileItem[]>([]);
  const [activeFileKey, setActiveFileKey] = useState<string>("");
  const [folderFilter, setFolderFilter] = useState<string>("");
  const [topMenu, setTopMenu] = useState<"view" | "export" | "lang" | null>(null);
  const [assocRegistered, setAssocRegistered] = useState<boolean>(false);

  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("shibanc-theme");
    return saved === "light" ? "light" : "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("shibanc-theme", theme);
  }, [theme]);

  const [gpuError, setGpuError] = useState<string | null>(null);
  const [program, setProgram] = useState<ProgramPayloadDto | null>(null);
  const [stock, setStock] = useState<StockSpec>({
    min: [-42, -42, -14],
    max: [42, 42, 0],
    inferred: true,
  });
  const [xyOriginMode, setXyOriginMode] = useState<"center" | "corner">("center");
  const [zDatumAnchor, setZDatumAnchor] = useState<"top" | "bottom">("top");
  const [tool, setTool] = useState<ToolSpec>({
    id: 1,
    kind: "tapered_ball_nose",
    diameter: 3.175,
    tip_radius: 0.4,
    half_angle_deg: 3.5,
    flute_length: 24,
    inferred: true,
  });

  const [materialId, setMaterialId] = useState<number>(1);
  const [gridMaxDim, setGridMaxDim] = useState<number>(1024);
  const [activeSegs, setActiveSegs] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playSpeed, setPlaySpeed] = useState<number>(10);

  const [viewMode, setViewMode] = useState<"solid" | "toolpath" | "both">("solid");
  const [showRapids, setShowRapids] = useState<boolean>(true);
  const [showCutter, setShowCutter] = useState<boolean>(true);
  const [showFloor, setShowFloor] = useState<boolean>(true);
  const [showGcodePanel, setShowGcodePanel] = useState<boolean>(true);

  // 3D Model Measurement Tool & Dynamic Cross-Section state
  const [measureMode, setMeasureMode] = useState<boolean>(false);
  const [measurements, setMeasurements] = useState<MeasurementPair[]>([]);
  const [pendingP1, setPendingP1] = useState<[number, number, number] | null>(null);
  const [hoverWorld, setHoverWorld] = useState<[number, number, number] | null>(null);
  const [sectionAxis, setSectionAxis] = useState<0 | 1 | 2>(0);
  const [sectionRatio, setSectionRatio] = useState<number>(0.5);
  const [precisionInfo, setPrecisionInfo] = useState<{
    mmPerCell: number;
    isRoi: boolean;
    subdiv: number;
  } | null>(null);

  const [camera, setCamera] = useState<CameraState>(DEFAULT_CAMERA);
  const [viewportLayout, setViewportLayout] =
    useState<ViewportLayoutMode>("single");
  const [splitX, setSplitX] = useState<number>(0.5);
  const [splitY, setSplitY] = useState<number>(0.5);
  const [auxPanes, setAuxPanes] = useState<
    [AuxPaneState, AuxPaneState, AuxPaneState]
  >(() => createDefaultAuxPanes());
  const [activePaneId, setActivePaneId] = useState<0 | 1 | 2 | 3>(0);
  const [tipInfo, setTipInfo] = useState<SegmentTipInfo | null>(null);
  const [cutterOverride, setCutterOverride] = useState<[number, number, number] | null>(
    null
  );
  const [wcsOrigin, setWcsOrigin] = useState<[number, number, number]>([0, 0, 0]);
  const [thumbRegistered, setThumbRegistered] = useState<boolean>(false);
  const [toast, setToast] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState<boolean>(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((prev) => (prev === msg ? null : prev));
    }, 3200);
  }, []);

  const applyLoadedPayload = useCallback(
    async (dto: ProgramPayloadDto, directBuffer?: ArrayBuffer) => {
      const rawBuf =
        directBuffer ?? (await invoke<ArrayBuffer>("get_segments_binary"));
      if (vpRef.current) {
        vpRef.current.uploadSegments(rawBuf);
      }
      setProgram(dto);
      setStock(dto.stock);
      const initXy: "center" | "corner" =
        dto.stock.min[0] >= -1.0 && dto.stock.min[1] >= -1.0 ? "corner" : "center";
      const initZ: "top" | "bottom" =
        Math.abs(dto.stock.min[2]) < 1e-3 && dto.stock.max[2] > 0.5 ? "bottom" : "top";
      setXyOriginMode(initXy);
      setZDatumAnchor(initZ);
      setCutterOverride(null);
      setMeasurements([]);
      setPendingP1(null);
      setHoverWorld(null);
      setSectionAxis(0);
      setSectionRatio(0.5);
      setWcsOrigin([
        initXy === "corner" ? dto.stock.min[0] : 0.5 * (dto.stock.min[0] + dto.stock.max[0]),
        initXy === "corner" ? dto.stock.min[1] : 0.5 * (dto.stock.min[1] + dto.stock.max[1]),
        initZ === "top" ? dto.stock.max[2] : dto.stock.min[2],
      ]);
      setTool(dto.tool);
      setMaterialId(dto.default_material_id);
      setActiveSegs(dto.stats.segment_count);
      setIsPlaying(false);
      setCamera(DEFAULT_CAMERA);
      setAuxPanes((prev) =>
        prev.map((ap) => ({
          ...ap,
          camera: { ...ap.camera, zoom: 1.05, panX: 0, panY: 0, panZ: 0 },
        })) as [AuxPaneState, AuxPaneState, AuxPaneState]
      );
      asyncRedrawRef.current();
    },
    []
  );

  const loadSample = useCallback(
    async (kind: "relief_tap" | "mechanical_nc") => {
      try {
        if (!isTauriRuntime()) {
          const s = generateWebSampleText(kind);
          const parsed = parseGcodeInBrowser(s.text, s.name, s.ext);
          await applyLoadedPayload(parsed.dto, parsed.segmentsBuffer);
          return;
        }
        const dto = await invoke<ProgramPayloadDto>("load_builtin_sample", {
          sampleKind: kind,
        });
        await applyLoadedPayload(dto);
      } catch (err) {
        showToast(tRef.current("toast.sampleError", { err: String(err) }));
      }
    },
    [applyLoadedPayload, showToast]
  );

  const loadBrowserFileObject = useCallback(
    async (file: File, registerInList = true) => {
      try {
        const text = await file.text();
        const ext = (file.name.split(".").pop() || "nc").toLowerCase();
        const parsed = parseGcodeInBrowser(text, file.name, ext);
        await applyLoadedPayload(parsed.dto, parsed.segmentsBuffer);
        const relKey =
          (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
          file.name;
        setActiveFileKey(relKey);
        if (registerInList) {
          setFolderFiles((prev) => {
            const exists = prev.some((it) => it.path === relKey);
            if (exists) {
              return prev.map((it) =>
                it.path === relKey
                  ? { ...it, size_bytes: file.size, browserFile: file }
                  : it
              );
            }
            return [
              ...prev,
              {
                name: file.name,
                path: relKey,
                size_bytes: file.size,
                ext,
                browserFile: file,
              },
            ];
          });
        }
        showToast(
          tRef.current("toast.loadedFile", { name: parsed.dto.stats.file_name })
        );
      } catch (err) {
        showToast(tRef.current("toast.readFileError", { err: String(err) }));
      }
    },
    [applyLoadedPayload, showToast]
  );

  const loadFileFromPath = useCallback(
    async (filePath: string, populateSiblings = false) => {
      try {
        const dto = await invoke<ProgramPayloadDto>("load_gcode_from_path", {
          path: filePath,
        });
        await applyLoadedPayload(dto);
        setActiveFileKey(filePath);
        if (populateSiblings) {
          const siblings = await invoke<FolderFileItem[]>("scan_gcode_folder", {
            folderPath: filePath,
          }).catch(() => []);
          if (siblings.length > 0) {
            setFolderFiles(siblings);
          }
        }
        showToast(
          tRef.current("toast.loadedFile", { name: dto.stats.file_name })
        );
      } catch (err) {
        showToast(tRef.current("toast.openFileError", { err: String(err) }));
      }
    },
    [applyLoadedPayload, showToast]
  );

  const loadFolderFromPath = useCallback(
    async (dirPath: string) => {
      try {
        const list = await invoke<FolderFileItem[]>("scan_gcode_folder", {
          folderPath: dirPath,
        });
        if (list.length === 0) {
          showToast(tRef.current("toast.emptyFolder"));
          return;
        }
        setFolderFiles(list);
        setFolderFilter("");
        setLeftTab("files");
        await loadFileFromPath(list[0].path, false);
        showToast(tRef.current("toast.loadedFolder", { count: list.length }));
      } catch (err) {
        showToast(tRef.current("toast.scanFolderError", { err: String(err) }));
      }
    },
    [loadFileFromPath, showToast]
  );

  const handleBrowserFolderFiles = useCallback(
    async (fileList: FileList) => {
      const validExts = new Set(["tap", "nc", "gcode", "cnc"]);
      const items: FolderFileItem[] = [];
      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i];
        const ext = (f.name.split(".").pop() || "").toLowerCase();
        if (validExts.has(ext)) {
          const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
          items.push({
            name: f.name,
            path: rel,
            size_bytes: f.size,
            ext,
            browserFile: f,
          });
        }
      }
      items.sort((a, b) => a.name.localeCompare(b.name));
      if (items.length === 0) {
        showToast(tRef.current("toast.noValidFiles"));
        return;
      }
      setFolderFiles((prev) => {
        const map = new Map<string, FolderFileItem>();
        for (const p of prev) map.set(p.path, p);
        for (const it of items) map.set(it.path, it);
        return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
      });
      setFolderFilter("");
      setLeftTab("files");
      setActiveFileKey(items[0].path);
      if (items[0].browserFile) {
        await loadBrowserFileObject(items[0].browserFile, false);
      }
      if (items.length > 1) {
        showToast(tRef.current("toast.importedFiles", { count: items.length }));
      }
    },
    [loadBrowserFileObject, showToast]
  );

  useEffect(() => {
    let disposed = false;

    (async () => {
      try {
        const shaders = isTauriRuntime()
          ? await invoke<ShadersDto>("get_wgsl_shaders")
          : getWebShaders();
        if (!canvasRef.current || disposed) return;
        const vp = await WebGpuViewport.create(
          canvasRef.current,
          shaders,
          () => asyncRedrawRef.current(),
          () => disposed
        );
        if (disposed) {
          vp.destroy();
          return;
        }
        vpRef.current = vp;

        if (isTauriRuntime()) {
          const reg = await invoke<boolean>("get_os_thumbnail_status").catch(() => false);
          setThumbRegistered(reg);
          const assoc = await invoke<boolean>("get_file_association_status").catch(() => false);
          setAssocRegistered(assoc);
          const startupPath = await invoke<string | null>("get_startup_file_arg").catch(
            () => null
          );
          if (startupPath) {
            const isDir = await invoke<boolean>("is_directory_path", {
              path: startupPath,
            }).catch(() => false);
            if (isDir) {
              await loadFolderFromPath(startupPath);
            } else {
              await loadFileFromPath(startupPath, true);
            }
          } else {
            await loadSample("relief_tap");
          }
        } else {
          await loadSample("relief_tap");
        }
      } catch (e) {
        if (!disposed) {
          setGpuError(String(e));
        }
      }
    })();

    let unlistenDrop: (() => void) | undefined;
    if (isTauriRuntime()) {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "over" || event.payload.type === "enter") {
            setIsDraggingFile(true);
          } else if (event.payload.type === "leave") {
            setIsDraggingFile(false);
          } else if (event.payload.type === "drop") {
            setIsDraggingFile(false);
            const first = event.payload.paths?.[0];
            if (first) {
              void invoke<boolean>("is_directory_path", { path: first })
                .then((isDir) => {
                  if (isDir) return loadFolderFromPath(first);
                  return loadFileFromPath(first, true);
                })
                .catch(() => {});
            }
          }
        })
        .then((fn) => {
          unlistenDrop = fn;
        })
        .catch(() => {});
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(tweenRafRef.current);
      cancelAnimationFrame(cutterTweenRafRef.current);
      if (renderRafRef.current !== 0) {
        cancelAnimationFrame(renderRafRef.current);
        renderRafRef.current = 0;
      }
      unlistenDrop?.();
      vpRef.current?.destroy();
      vpRef.current = null;
    };
  }, [loadFileFromPath, loadFolderFromPath, loadSample]);

  // Global mouse move/up handler for resizing Left & Right sidebars
  useEffect(() => {
    if (!resizingSide) return;
    const onMove = (e: MouseEvent) => {
      if (resizingSide === "left") {
        const w = Math.min(Math.max(e.clientX, 210), 480);
        setLeftWidth(w);
        localStorage.setItem("shibanc-left-w", String(w));
      } else {
        const w = Math.min(Math.max(window.innerWidth - e.clientX, 220), 560);
        setRightWidth(w);
        localStorage.setItem("shibanc-right-w", String(w));
      }
    };
    const onUp = () => setResizingSide(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizingSide]);

  // Playback loop
  useEffect(() => {
    if (!isPlaying || !program) return;
    const total = program.stats.segment_count;
    let raf = 0;

    const stepFrame = () => {
      setActiveSegs((prev) => {
        if (prev >= total) {
          setIsPlaying(false);
          return total;
        }
        const delta = Math.max(Math.round((total / 900) * (playSpeed / 5)), 1);
        const next = Math.min(prev + delta, total);
        if (next >= total) setIsPlaying(false);
        return next;
      });
      raf = requestAnimationFrame(stepFrame);
    };
    raf = requestAnimationFrame(stepFrame);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, playSpeed, program]);

  const activePanes = buildActivePanes(
    viewportLayout,
    splitX,
    splitY,
    camera,
    auxPanes
  );

  // On-Demand Render Engine (0% GPU load when idle; redraws only on state/resize/async ROI updates)
  const renderStateRef = useRef({
    program,
    stock,
    tool,
    materialId,
    gridMaxDim,
    activeSegs,
    viewMode,
    showRapids,
    showCutter,
    showFloor,
    darkMode: theme === "dark",
    camera,
    activePanes,
    cutterOverride,
    wcsOrigin,
    sectionAxis,
    sectionRatio,
  });
  renderStateRef.current = {
    program,
    stock,
    tool,
    materialId,
    gridMaxDim,
    activeSegs,
    viewMode,
    showRapids,
    showCutter,
    showFloor,
    darkMode: theme === "dark",
    camera,
    activePanes,
    cutterOverride,
    wcsOrigin,
    sectionAxis,
    sectionRatio,
  };

  const drawFrameNow = useCallback(() => {
    const st = renderStateRef.current;
    const vp = vpRef.current;
    if (!vp || !st.program) return;
    const showSolid = st.viewMode !== "toolpath";
    const showLines = st.viewMode !== "solid";
    vp.render({
      stock: st.stock,
      tool: st.tool,
      materialId: st.materialId,
      gridMaxDim: st.gridMaxDim,
      activeSegments: st.activeSegs,
      showSolid,
      showCutsOverlay: showLines,
      showRapidsOverlay: showLines && st.showRapids,
      showStockBox: st.viewMode === "toolpath",
      showCutter: st.showCutter,
      showFloor: st.showFloor,
      darkMode: st.darkMode,
      camera: st.camera,
      subViewports: st.activePanes.map((ap) => ({
        rect: ap.rect,
        camera: ap.camera,
      })),
      cutterOverride: st.cutterOverride,
      wcsOrigin: st.wcsOrigin,
      sectionAxis: st.sectionAxis,
      sectionRatio: st.sectionRatio,
    });
    const prec = vp.getActivePrecisionInfo();
    setPrecisionInfo((prev) =>
      prev &&
      prev.isRoi === prec.isRoi &&
      prev.subdiv === prec.subdiv &&
      Math.abs(prev.mmPerCell - prec.mmPerCell) < 1e-5
        ? prev
        : prec
    );
  }, []);

  const requestRender = useCallback(() => {
    if (renderRafRef.current !== 0) return;
    renderRafRef.current = requestAnimationFrame(() => {
      renderRafRef.current = 0;
      drawFrameNow();
    });
  }, [drawFrameNow]);
  asyncRedrawRef.current = requestRender;

  // Bind async ROI completion callback & trigger demand-driven render on any state change
  useEffect(() => {
    vpRef.current?.setOnAsyncUpdate(requestRender);
    requestRender();
  }, [
    program,
    stock,
    tool,
    materialId,
    gridMaxDim,
    activeSegs,
    viewMode,
    showRapids,
    showCutter,
    showFloor,
    theme,
    camera,
    viewportLayout,
    splitX,
    splitY,
    auxPanes,
    cutterOverride,
    wcsOrigin,
    sectionAxis,
    sectionRatio,
    requestRender,
  ]);

  // Redraw cleanly whenever the 3D viewport container resizes
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => requestRender());
    ro.observe(el);
    return () => ro.disconnect();
  }, [requestRender]);

  // Update live cutter tip XYZ & line number
  useEffect(() => {
    if (!vpRef.current) return;
    const info = vpRef.current.getSegmentTip(activeSegs);
    setTipInfo(info);
  }, [activeSegs, program]);

  // Smooth Camera Orientation Transition (when clicking ViewCube vertices / faces / Home)
  const animateCameraTo = useCallback(
    (
      targetYaw: number,
      targetPitch: number,
      resetPanZoom = false,
      targetOrtho?: boolean
    ) => {
      cancelAnimationFrame(tweenRafRef.current);
      const startCam = renderStateRef.current.camera;
      // Shortest angular path for yaw
      let dyaw = ((targetYaw - startCam.yawDeg + 540) % 360) - 180;
      if (dyaw < -180) dyaw += 360;
      const endYaw = startCam.yawDeg + dyaw;
      const startTime = performance.now();
      const duration = 220;

      const tick = (now: number) => {
        const t = Math.min((now - startTime) / duration, 1);
        const ease = 1 - Math.pow(1 - t, 3);
        setCamera((prev) => ({
          yawDeg: startCam.yawDeg + (endYaw - startCam.yawDeg) * ease,
          pitchDeg: startCam.pitchDeg + (targetPitch - startCam.pitchDeg) * ease,
          zoom: resetPanZoom
            ? startCam.zoom + (DEFAULT_CAMERA.zoom - startCam.zoom) * ease
            : prev.zoom,
          panX: resetPanZoom ? startCam.panX * (1 - ease) : prev.panX,
          panY: resetPanZoom ? startCam.panY * (1 - ease) : prev.panY,
          panZ: resetPanZoom ? startCam.panZ * (1 - ease) : prev.panZ,
          ortho: targetOrtho !== undefined ? targetOrtho : prev.ortho,
        }));
        if (t < 1) {
          tweenRafRef.current = requestAnimationFrame(tick);
        }
      };
      tweenRafRef.current = requestAnimationFrame(tick);
    },
    []
  );

  // Escape key cancels in-progress measurement point or exits measure mode
  useEffect(() => {
    if (!measureMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (pendingP1) {
          setPendingP1(null);
        } else {
          setMeasureMode(false);
          setHoverWorld(null);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [measureMode, pendingP1]);

  // Zero-lag synchronous 3D -> 2D CSS projection matching active sub-viewport camera matrices
  const projectWorldPoint = useCallback(
    (pt: [number, number, number]) => {
      const cvs = canvasRef.current;
      if (!cvs) return { x: -9999, y: -9999, visible: false };
      const cw = Math.max(cvs.clientWidth, 1);
      const ch = Math.max(cvs.clientHeight, 1);
      const pane =
        activePanes.find((ap) => ap.paneId === activePaneId) ?? activePanes[0];
      const [rx, ry, rw, rh] = pane.rect;
      const pw = Math.max(rw * cw, 1);
      const ph = Math.max(rh * ch, 1);
      const cam = pane.camera;

      const sx = stock.max[0] - stock.min[0];
      const sy = stock.max[1] - stock.min[1];
      const sz = stock.max[2] - stock.min[2];
      const center: [number, number, number] = [
        0.5 * (stock.min[0] + stock.max[0]) + cam.panX,
        0.5 * (stock.min[1] + stock.max[1]) + cam.panY,
        0.5 * (stock.min[2] + stock.max[2]) + cam.panZ,
      ];
      const diag = Math.hypot(sx, sy, sz);
      const radius = Math.max(diag * 0.5, 5.0);
      const fovY = (33.0 * Math.PI) / 180.0;
      const aspect = pw / ph;
      const fitFactor = aspect < 1.0 ? 1.0 / aspect : 1.0;
      const dist =
        ((radius / Math.tan(fovY * 0.5)) * 1.18 * fitFactor) /
        Math.max(cam.zoom, 0.15);
      const yaw = (cam.yawDeg * Math.PI) / 180.0;
      const pitch =
        (Math.min(Math.max(cam.pitchDeg, -89.2), 89.2) * Math.PI) / 180.0;
      const isOrtho = Boolean(cam.ortho);
      const eyeDist = isOrtho ? Math.max(dist, radius * 16.0) : dist;
      const eye: [number, number, number] = [
        center[0] + eyeDist * Math.cos(pitch) * Math.sin(yaw),
        center[1] - eyeDist * Math.cos(pitch) * Math.cos(yaw),
        center[2] + eyeDist * Math.sin(pitch),
      ];
      const halfH = (radius * 1.18 * fitFactor) / Math.max(cam.zoom, 0.15);
      const proj = isOrtho
        ? orthoRhZeroToOne(halfH * aspect, halfH, 0.1, eyeDist * 3.0)
        : perspectiveRhZeroToOne(fovY, aspect, Math.max(dist * 0.02, 0.2), dist * 5.0);
      const view = lookAtRh(eye, center, [0, 0, 1]);
      const vp = mulMat4(proj, view);
      const sp = projectPointToCss(vp, pt, pw, ph);
      const inBounds = sp.x >= -2 && sp.x <= pw + 2 && sp.y >= -2 && sp.y <= ph + 2;
      return {
        x: rx * cw + sp.x,
        y: ry * ch + sp.y,
        visible: sp.visible && inBounds,
      };
    },
    [stock, activePanes, activePaneId]
  );

  const findPaneAtCss = useCallback(
    (localX: number, localY: number): PaneDescriptor => {
      const cvs = canvasRef.current;
      const cw = Math.max(cvs?.clientWidth ?? 1, 1);
      const ch = Math.max(cvs?.clientHeight ?? 1, 1);
      const nx = localX / cw;
      const ny = localY / ch;
      return (
        activePanes.find(
          (ap) =>
            nx >= ap.rect[0] &&
            nx <= ap.rect[0] + ap.rect[2] &&
            ny >= ap.rect[1] &&
            ny <= ap.rect[1] + ap.rect[3]
        ) ?? activePanes[0]
      );
    },
    [activePanes]
  );

  const updatePaneCamera = useCallback(
    (paneId: 0 | 1 | 2 | 3, updater: (prev: CameraState) => CameraState) => {
      if (paneId === 0) {
        setCamera(updater);
      } else {
        const auxIdx = paneId - 1;
        setAuxPanes((prev) => {
          const next = [...prev] as [AuxPaneState, AuxPaneState, AuxPaneState];
          next[auxIdx] = { ...next[auxIdx], camera: updater(next[auxIdx].camera) };
          return next;
        });
      }
    },
    []
  );

  // Canvas Orbit / Pan / Zoom (per sub-viewport!) + 3D Surface Measurement Ray-Picking
  const dragRef = useRef({
    active: false,
    paneId: 0 as 0 | 1 | 2 | 3,
    paneW: 400,
    paneH: 400,
    panMode: false,
    button: 0,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    moved: false,
  });

  const onCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    cancelAnimationFrame(tweenRafRef.current);
    const cvs = canvasRef.current;
    const rect = cvs?.getBoundingClientRect();
    const lx = rect ? e.clientX - rect.left : 0;
    const ly = rect ? e.clientY - rect.top : 0;
    const hitPane = findPaneAtCss(lx, ly);
    setActivePaneId(hitPane.paneId);

    const cw = Math.max(cvs?.clientWidth ?? 1, 1);
    const ch = Math.max(cvs?.clientHeight ?? 1, 1);
    // In locked orthographic 2D views (Top/Front/Right), drag pans smoothly unless Alt is held to free-orbit!
    const wantPan =
      e.button === 1 ||
      e.button === 2 ||
      e.shiftKey ||
      (hitPane.lockRotation && !e.altKey);

    dragRef.current = {
      active: true,
      paneId: hitPane.paneId,
      paneW: Math.max(hitPane.rect[2] * cw, 1),
      paneH: Math.max(hitPane.rect[3] * ch, 1),
      panMode: wantPan,
      button: e.button,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
    };
  };

  const onCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current.active) {
      if (measureMode && vpRef.current && canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect();
        const lx = e.clientX - rect.left;
        const ly = e.clientY - rect.top;
        const hp = findPaneAtCss(lx, ly);
        if (hp.paneId !== activePaneId) {
          setActivePaneId(hp.paneId);
        }
        const hit = vpRef.current.pickModelPoint(
          lx,
          ly,
          viewMode !== "toolpath",
          activeSegs
        );
        setHoverWorld(hit);
      }
      return;
    }

    const dx = e.clientX - dragRef.current.lastX;
    const dy = e.clientY - dragRef.current.lastY;
    if (
      Math.hypot(
        e.clientX - dragRef.current.startX,
        e.clientY - dragRef.current.startY
      ) > 4
    ) {
      dragRef.current.moved = true;
    }
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;

    if (!dragRef.current.moved && measureMode) {
      return;
    }

    const targetPaneId = dragRef.current.paneId;
    if (dragRef.current.panMode) {
      const sx = stock.max[0] - stock.min[0];
      const sy = stock.max[1] - stock.min[1];
      const sz = stock.max[2] - stock.min[2];
      const radius = Math.max(Math.hypot(sx, sy, sz) * 0.5, 5.0);
      const pw = dragRef.current.paneW;
      const ph = dragRef.current.paneH;
      updatePaneCamera(targetPaneId, (c) =>
        panCameraInPlane(c, dx, dy, pw, ph, radius)
      );
    } else {
      updatePaneCamera(targetPaneId, (c) => ({
        ...c,
        yawDeg: c.yawDeg - dx * 0.38,
        pitchDeg: Math.min(Math.max(c.pitchDeg + dy * 0.35, -89.2), 89.2),
      }));
    }
  };

  const onCanvasMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const wasActive = dragRef.current.active;
    const wasMoved = dragRef.current.moved;
    const btn = dragRef.current.button;
    dragRef.current.active = false;

    if (
      measureMode &&
      wasActive &&
      !wasMoved &&
      btn === 0 &&
      vpRef.current &&
      canvasRef.current
    ) {
      const rect = canvasRef.current.getBoundingClientRect();
      const hit = vpRef.current.pickModelPoint(
        e.clientX - rect.left,
        e.clientY - rect.top,
        viewMode !== "toolpath",
        activeSegs
      );
      if (hit) {
        if (!pendingP1) {
          setPendingP1(hit);
        } else {
          setMeasurements((prev) => [
            ...prev,
            { id: Date.now() + Math.random(), p1: pendingP1, p2: hit },
          ]);
          setPendingP1(null);
        }
      }
    }
  };

  const onCanvasMouseLeave = () => {
    dragRef.current.active = false;
    if (measureMode) {
      setHoverWorld(null);
    }
  };

  const onCanvasWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const lx = rect ? e.clientX - rect.left : 0;
    const ly = rect ? e.clientY - rect.top : 0;
    const hitPane = findPaneAtCss(lx, ly);
    if (hitPane.paneId !== activePaneId) {
      setActivePaneId(hitPane.paneId);
    }
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    updatePaneCamera(hitPane.paneId, (c) => ({
      ...c,
      zoom: Math.min(Math.max(c.zoom * factor, 0.15), 18.0),
    }));
  };

  const handleOpenFileDialog = async () => {
    if (!isTauriRuntime()) {
      webFileInputRef.current?.click();
      return;
    }
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: t("dialog.filterGcode"),
          extensions: ["tap", "nc", "gcode", "cnc"],
        },
      ],
    });
    if (Array.isArray(selected) && selected.length > 0) {
      if (selected.length === 1) {
        await loadFileFromPath(selected[0], true);
      } else {
        const added: FolderFileItem[] = selected.map((p) => {
          const name = p.split(/[\\/]/).pop() || p;
          const ext = (name.split(".").pop() || "nc").toLowerCase();
          return { name, path: p, size_bytes: 0, ext };
        });
        setFolderFiles((prev) => {
          const map = new Map<string, FolderFileItem>();
          for (const it of prev) map.set(it.path, it);
          for (const it of added) map.set(it.path, it);
          return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
        });
        setLeftTab("files");
        await loadFileFromPath(selected[0], false);
      }
    } else if (typeof selected === "string") {
      await loadFileFromPath(selected, true);
    }
  };

  const handleOpenFolderDialog = async () => {
    if (!isTauriRuntime()) {
      webFolderInputRef.current?.click();
      return;
    }
    const selectedDir = await open({
      directory: true,
      multiple: false,
      title: t("dialog.openFolderTitle"),
    });
    if (typeof selectedDir === "string") {
      await loadFolderFromPath(selectedDir);
    }
  };

  const handleExportHdPng = async () => {
    setTopMenu(null);
    if (!program) return;
    const baseName = program.stats.file_name.replace(/\.[^.]+$/, "");
    const suffix = t("dialog.exportPreviewSuffix");
    const dlName = `${baseName}${suffix}`;
    if (!isTauriRuntime()) {
      if (!canvasRef.current) return;
      drawFrameNow();
      const url = canvasRef.current.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = dlName;
      a.click();
      showToast(t("toast.downloadedPng", { name: dlName }));
      return;
    }
    const target = await save({
      defaultPath: dlName,
      filters: [{ name: t("dialog.filterPng"), extensions: ["png"] }],
    });
    if (!target) return;

    try {
      await invoke("export_hd_render_png", {
        outputPath: target,
        width: 1920,
        height: 1440,
        gridMaxDim: Math.max(gridMaxDim, 1536),
        materialId,
        stockMin: stock.min,
        stockMax: stock.max,
        toolKindCode: TOOL_KIND_CODE[tool.kind],
        toolDiameter: tool.diameter,
        toolTipRadius: tool.tip_radius,
        toolHalfAngleDeg: tool.half_angle_deg,
        yawDeg: camera.yawDeg,
        pitchDeg: camera.pitchDeg,
        zoom: camera.zoom,
        showCuts: viewMode !== "solid",
        showRapids: viewMode !== "solid" && showRapids,
        showCutter,
        showSolid: viewMode !== "toolpath",
        activeSegments: activeSegs,
      });
      showToast(t("toast.exportedPng", { path: target }));
    } catch (err) {
      showToast(t("toast.exportError", { err: String(err) }));
    }
  };

  const handleExportStlModel = async () => {
    setTopMenu(null);
    if (!program) return;
    const baseName = program.stats.file_name.replace(/\.[^.]+$/, "");

    if (!isTauriRuntime()) {
      if (!vpRef.current) return;
      try {
        showToast(t("toast.generatingStl"));
        const { buffer, triCount } = await vpRef.current.exportBinaryStl();
        const blob = new Blob([buffer], { type: "model/stl" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${baseName}.stl`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        showToast(
          t("toast.downloadedStl", {
            name: `${baseName}.stl`,
            count: triCount.toLocaleString(),
          })
        );
      } catch (err) {
        showToast(t("toast.stlError", { err: String(err) }));
      }
      return;
    }

    const target = await save({
      defaultPath: `${baseName}.stl`,
      filters: [{ name: t("dialog.filterStl"), extensions: ["stl"] }],
    });
    if (!target) return;

    try {
      const tris = await invoke<number>("export_stl_model", {
        outputPath: target,
        gridMaxDim: Math.max(gridMaxDim, 768),
        stockMin: stock.min,
        stockMax: stock.max,
        toolKindCode: TOOL_KIND_CODE[tool.kind],
        toolDiameter: tool.diameter,
        toolTipRadius: tool.tip_radius,
        toolHalfAngleDeg: tool.half_angle_deg,
        activeSegments: activeSegs,
      });
      showToast(
        t("toast.exportedStl", {
          count: tris.toLocaleString(),
          path: target,
        })
      );
    } catch (err) {
      showToast(t("toast.stlError", { err: String(err) }));
    }
  };

  const handleToggleThumbnails = async () => {
    if (!isTauriRuntime()) {
      showToast(t("toast.desktopThumbOnly"));
      return;
    }
    try {
      const next = !thumbRegistered;
      const msg = await invoke<string>("toggle_os_thumbnails", { enable: next });
      setThumbRegistered(next);
      showToast(msg);
    } catch (err) {
      showToast(String(err));
    }
  };

  const handleToggleFileAssociations = async () => {
    if (!isTauriRuntime()) {
      showToast(t("toast.desktopAssocOnly"));
      return;
    }
    try {
      const next = !assocRegistered;
      const msg = await invoke<string>("toggle_file_associations", { enable: next });
      setAssocRegistered(next);
      showToast(msg);
    } catch (err) {
      showToast(String(err));
    }
  };

  const togglePlay = useCallback(() => {
    if (!program) return;
    cancelAnimationFrame(cutterTweenRafRef.current);
    setCutterOverride(null);
    setIsPlaying((prevPlaying) => {
      if (!prevPlaying && activeSegs >= program.stats.segment_count) {
        setActiveSegs(0);
      }
      return !prevPlaying;
    });
  }, [program, activeSegs]);

  const stepSegments = useCallback(
    (delta: number, keepPlaying = false) => {
      if (!program) return;
      cancelAnimationFrame(cutterTweenRafRef.current);
      setCutterOverride(null);
      if (!keepPlaying) {
        setIsPlaying(false);
      }
      setActiveSegs((prev) =>
        Math.min(Math.max(prev + delta, 0), program.stats.segment_count)
      );
    },
    [program]
  );

  const cyclePlaySpeed = useCallback(
    (dir: 1 | -1) => {
      setPlaySpeed((prev) => {
        const curIdx = SPEED_OPTIONS.findIndex((s) => s.value === prev);
        const baseIdx = curIdx >= 0 ? curIdx : 2;
        const nextIdx = Math.min(
          Math.max(baseIdx + dir, 0),
          SPEED_OPTIONS.length - 1
        );
        const nextOpt = SPEED_OPTIONS[nextIdx];
        if (nextOpt.value !== prev) {
          showToast(
            tRef.current("toast.speedChanged", {
              label: nextOpt.label,
              desc: tRef.current(nextOpt.descKey),
            })
          );
        }
        return nextOpt.value;
      });
    },
    [showToast]
  );

  const handleSelectPanePreset = useCallback(
    (paneId: 0 | 1 | 2 | 3, opt: PanePresetOption) => {
      if (paneId === 0) {
        animateCameraTo(opt.yawDeg, opt.pitchDeg, false, opt.ortho);
      } else {
        const auxIdx = paneId - 1;
        setAuxPanes((prev) => {
          const next = [...prev] as [AuxPaneState, AuxPaneState, AuxPaneState];
          next[auxIdx] = {
            preset: opt.id,
            lockRotation: opt.lockRotation,
            camera: {
              ...next[auxIdx].camera,
              yawDeg: opt.yawDeg,
              pitchDeg: opt.pitchDeg,
              ortho: opt.ortho,
            },
          };
          return next;
        });
      }
    },
    [animateCameraTo]
  );

  const handleResetPaneFit = useCallback(
    (paneId: 0 | 1 | 2 | 3) => {
      if (paneId === 0) {
        animateCameraTo(
          DEFAULT_CAMERA.yawDeg,
          DEFAULT_CAMERA.pitchDeg,
          true,
          false
        );
      } else {
        updatePaneCamera(paneId, (c) => ({
          ...c,
          zoom: 1.05,
          panX: 0,
          panY: 0,
          panZ: 0,
        }));
      }
    },
    [animateCameraTo, updatePaneCamera]
  );

  const handleMaximizePane = useCallback((pane: PaneDescriptor) => {
    setCamera({ ...pane.camera });
    setViewportLayout("single");
    setActivePaneId(0);
  }, []);

  // Global Playback, Fast-Forward, Multi-View (Blender Ctrl+Alt+Q / Q) & CAD Keyboard Shortcuts
  useEffect(() => {
    const onGlobalKeyDown = (e: KeyboardEvent) => {
      // Blender standard Quad View shortcut: Ctrl + Alt + Q
      if (
        (e.ctrlKey || e.metaKey) &&
        e.altKey &&
        (e.key === "q" || e.key === "Q" || e.code === "KeyQ")
      ) {
        e.preventDefault();
        if (!e.repeat) {
          setViewportLayout((m) => (m === "quad" ? "single" : "quad"));
        }
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
        if (tag === "INPUT") {
          const inpType = (target as HTMLInputElement).type;
          // Only block shortcuts when typing inside a text/search/number box; allow on range sliders!
          if (inpType !== "range" && inpType !== "button" && inpType !== "checkbox") {
            return;
          }
        }
      }

      const total = program?.stats.segment_count ?? 0;
      const step5Pct = Math.max(Math.round(total * 0.05), 10);
      const step10Pct = Math.max(Math.round(total * 0.1), 25);
      const stepHold = Math.max(Math.round(total * 0.015), 5);

      if (e.code === "Space" || e.key === "k" || e.key === "K") {
        e.preventDefault();
        if (e.repeat) return;
        if (target && target.tagName === "BUTTON") {
          target.blur();
        }
        togglePlay();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (e.shiftKey) {
          stepSegments(step10Pct, isPlaying);
        } else if (isPlaying) {
          stepSegments(step5Pct, true);
        } else if (e.repeat) {
          stepSegments(stepHold, false);
        } else {
          stepSegments(1, false);
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (e.shiftKey) {
          stepSegments(-step10Pct, isPlaying);
        } else if (isPlaying) {
          stepSegments(-step5Pct, true);
        } else if (e.repeat) {
          stepSegments(-stepHold, false);
        } else {
          stepSegments(-1, false);
        }
      } else if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        stepSegments(step5Pct, isPlaying);
      } else if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        stepSegments(-step5Pct, isPlaying);
      } else if (e.key === ".") {
        e.preventDefault();
        stepSegments(1, false);
      } else if (e.key === ",") {
        e.preventDefault();
        stepSegments(-1, false);
      } else if (!e.shiftKey && e.key >= "1" && e.key <= "6") {
        e.preventDefault();
        if (e.repeat) return;
        const opt = SPEED_OPTIONS[Number(e.key) - 1];
        if (opt) {
          setPlaySpeed(opt.value);
          showToast(
            tRef.current("toast.speedChanged", {
              label: opt.label,
              desc: tRef.current(opt.descKey),
            })
          );
        }
      } else if (
        e.key === "ArrowUp" ||
        e.key === "]" ||
        e.key === "=" ||
        e.key === "+"
      ) {
        e.preventDefault();
        cyclePlaySpeed(1);
      } else if (
        e.key === "ArrowDown" ||
        e.key === "[" ||
        e.key === "-"
      ) {
        e.preventDefault();
        cyclePlaySpeed(-1);
      } else if (e.key === "Home" || e.key === "0") {
        if (program) {
          e.preventDefault();
          cancelAnimationFrame(cutterTweenRafRef.current);
          setCutterOverride(null);
          setIsPlaying(false);
          setActiveSegs(0);
        }
      } else if (e.key === "End") {
        if (program) {
          e.preventDefault();
          cancelAnimationFrame(cutterTweenRafRef.current);
          setCutterOverride(null);
          setIsPlaying(false);
          setActiveSegs(total);
        }
      } else if (e.key === "q" || e.key === "Q") {
        e.preventDefault();
        if (!e.repeat) {
          setViewportLayout((m) => (m === "quad" ? "single" : "quad"));
        }
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        handleResetPaneFit(viewportLayout === "single" ? 0 : activePaneId);
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        setMeasureMode((m) => {
          if (m) {
            setPendingP1(null);
            setHoverWorld(null);
          }
          return !m;
        });
      } else if (e.key === "Escape") {
        setTopMenu(null);
      }
    };
    window.addEventListener("keydown", onGlobalKeyDown);
    return () => window.removeEventListener("keydown", onGlobalKeyDown);
  }, [
    program,
    isPlaying,
    viewportLayout,
    activePaneId,
    togglePlay,
    stepSegments,
    cyclePlaySpeed,
    handleResetPaneFit,
    showToast,
  ]);

  // Close topbar dropdown/popover when clicking anywhere outside the active anchor
  useEffect(() => {
    if (!topMenu) return;
    const onDocDown = (e: MouseEvent) => {
      if (topbarRef.current && !topbarRef.current.contains(e.target as Node)) {
        setTopMenu(null);
      }
    };
    window.addEventListener("mousedown", onDocDown);
    return () => window.removeEventListener("mousedown", onDocDown);
  }, [topMenu]);

  const stockDims = [
    Math.max(stock.max[0] - stock.min[0], 1),
    Math.max(stock.max[1] - stock.min[1], 1),
    Math.max(stock.max[2] - stock.min[2], 0.1),
  ];

  const handleSizeXChange = (newW: number) => {
    const w = Math.max(newW, 1);
    setStock((prev) => {
      if (xyOriginMode === "corner") {
        return {
          ...prev,
          min: [0, prev.min[1], prev.min[2]],
          max: [w, prev.max[1], prev.max[2]],
          inferred: false,
        };
      }
      const cx = 0.5 * (prev.min[0] + prev.max[0]);
      return {
        ...prev,
        min: [cx - w * 0.5, prev.min[1], prev.min[2]],
        max: [cx + w * 0.5, prev.max[1], prev.max[2]],
        inferred: false,
      };
    });
  };

  const handleSizeYChange = (newH: number) => {
    const h = Math.max(newH, 1);
    setStock((prev) => {
      if (xyOriginMode === "corner") {
        return {
          ...prev,
          min: [prev.min[0], 0, prev.min[2]],
          max: [prev.max[0], h, prev.max[2]],
          inferred: false,
        };
      }
      const cy = 0.5 * (prev.min[1] + prev.max[1]);
      return {
        ...prev,
        min: [prev.min[0], cy - h * 0.5, prev.min[2]],
        max: [prev.max[0], cy + h * 0.5, prev.max[2]],
        inferred: false,
      };
    });
  };

  const handleThicknessChange = (newThickness: number) => {
    const h = Math.max(newThickness, 0.2);
    setStock((prev) => {
      if (zDatumAnchor === "bottom") {
        return {
          ...prev,
          max: [prev.max[0], prev.max[1], prev.min[2] + h],
          inferred: false,
        };
      }
      return {
        ...prev,
        min: [prev.min[0], prev.min[1], prev.max[2] - h],
        inferred: false,
      };
    });
  };

  // Smooth 3D CNC Cutter Touch-Off Arc Animation when switching XY/Z origin modes
  const animateCutterToOrigin = useCallback(
    (targetStock: StockSpec, xyMode: "center" | "corner", zMode: "top" | "bottom") => {
      cancelAnimationFrame(cutterTweenRafRef.current);
      setIsPlaying(false);
      setShowCutter(true);

      const endPos: [number, number, number] = [
        xyMode === "corner"
          ? targetStock.min[0]
          : 0.5 * (targetStock.min[0] + targetStock.max[0]),
        xyMode === "corner"
          ? targetStock.min[1]
          : 0.5 * (targetStock.min[1] + targetStock.max[1]),
        zMode === "top" ? targetStock.max[2] : targetStock.min[2],
      ];

      const startPos =
        vpRef.current?.getCurrentCutterPos() ?? [
          0.5 * (targetStock.min[0] + targetStock.max[0]),
          0.5 * (targetStock.min[1] + targetStock.max[1]),
          targetStock.max[2] + 10,
        ];
      const startWcs = renderStateRef.current.wcsOrigin;

      const xyDist = Math.hypot(endPos[0] - startPos[0], endPos[1] - startPos[1]);
      // Parabolic safe-Z retract clearance above the stock top during horizontal travel
      const safeClearance =
        xyDist > 1.0
          ? Math.max(targetStock.max[2] + 10, Math.max(startPos[2], endPos[2]) + 8)
          : Math.max(startPos[2], endPos[2]) + 3;

      const t0 = performance.now();
      const duration = 460;

      const step = (now: number) => {
        const t = Math.min((now - t0) / duration, 1);
        const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

        const cx = startPos[0] + (endPos[0] - startPos[0]) * ease;
        const cy = startPos[1] + (endPos[1] - startPos[1]) * ease;
        const baseZ = startPos[2] + (endPos[2] - startPos[2]) * ease;
        const arcPeak = Math.max(safeClearance - baseZ, 0) * Math.sin(Math.PI * t);
        const cz = baseZ + arcPeak;

        setCutterOverride([cx, cy, cz]);
        setWcsOrigin([
          startWcs[0] + (endPos[0] - startWcs[0]) * ease,
          startWcs[1] + (endPos[1] - startWcs[1]) * ease,
          startWcs[2] + (endPos[2] - startWcs[2]) * ease,
        ]);

        if (t < 1) {
          cutterTweenRafRef.current = requestAnimationFrame(step);
        }
      };

      cutterTweenRafRef.current = requestAnimationFrame(step);
    },
    []
  );

  // Keep WCS triad synced if user edits stock dimensions directly
  useEffect(() => {
    setWcsOrigin([
      xyOriginMode === "corner" ? stock.min[0] : 0.5 * (stock.min[0] + stock.max[0]),
      xyOriginMode === "corner" ? stock.min[1] : 0.5 * (stock.min[1] + stock.max[1]),
      zDatumAnchor === "top" ? stock.max[2] : stock.min[2],
    ]);
  }, [stock, xyOriginMode, zDatumAnchor]);

  const applyXyOriginMode = (mode: "center" | "corner") => {
    setXyOriginMode(mode);
    animateCutterToOrigin(stock, mode, zDatumAnchor);
  };

  const applyZDatumAnchor = (anchor: "top" | "bottom") => {
    setZDatumAnchor(anchor);
    animateCutterToOrigin(stock, xyOriginMode, anchor);
  };

  const progressPct = program
    ? (activeSegs / Math.max(program.stats.segment_count, 1)) * 100
    : 100;

  // Pre-calculate fixed character widths for bottom dock so numbers never jitter during playback
  const lineDigits = program
    ? Math.max(String(program.stats.total_lines).length, 4)
    : 4;
  const maxCoordAbs = Math.max(
    Math.abs(stock.min[0]),
    Math.abs(stock.max[0]),
    Math.abs(stock.min[1]),
    Math.abs(stock.max[1]),
    Math.abs(stock.min[2]),
    Math.abs(stock.max[2]),
    program ? Math.abs(program.stats.cut_bounds_min[0]) : 0,
    program ? Math.abs(program.stats.cut_bounds_max[0]) : 0,
    program ? Math.abs(program.stats.cut_bounds_min[1]) : 0,
    program ? Math.abs(program.stats.cut_bounds_max[1]) : 0,
    program ? Math.abs(program.stats.cut_bounds_min[2]) : 0,
    program ? Math.abs(program.stats.cut_bounds_max[2]) : 0,
    999.9
  );
  const xyzChars = (-maxCoordAbs).toFixed(1).length;

  return (
    <div
      className="app-shell"
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={(e) => {
        if (!isTauriRuntime()) {
          e.preventDefault();
          setIsDraggingFile(true);
        }
      }}
      onDragLeave={() => {
        if (!isTauriRuntime()) setIsDraggingFile(false);
      }}
      onDrop={(e) => {
        if (!isTauriRuntime()) {
          e.preventDefault();
          setIsDraggingFile(false);
          if (e.dataTransfer.files && e.dataTransfer.files.length > 1) {
            void handleBrowserFolderFiles(e.dataTransfer.files);
          } else {
            const f = e.dataTransfer.files?.[0];
            if (f) void loadBrowserFileObject(f);
          }
        }
      }}
    >
      <input
        ref={webFileInputRef}
        type="file"
        multiple
        accept=".tap,.nc,.gcode,.cnc"
        style={{ display: "none" }}
        onChange={(e) => {
          const files = e.target.files;
          if (files && files.length > 1) {
            void handleBrowserFolderFiles(files);
          } else if (files && files.length === 1) {
            void loadBrowserFileObject(files[0], true);
          }
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={webFolderInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            void handleBrowserFolderFiles(e.target.files);
          }
          e.currentTarget.value = "";
        }}
      />

      {/* Streamlined 3-Zone Topbar: Left (Brand) · Center (Mode & Inspect) · Right (View, Export, Theme) */}
      <header className="topbar" ref={topbarRef}>
        <div className="toolbar-left">
          <div className="brand">
            <span className="brand-mark">S</span>
            <span>ShibaNC</span>
          </div>
        </div>

        {/* Center Zone: Core Display Mode + Section & Measure */}
        <div className="toolbar-center">
          <div className="sh-tabs">
            <button
              className={`sh-tab ${viewMode === "solid" ? "active" : ""}`}
              onClick={() => setViewMode("solid")}
              title={t("topbar.mode.solidTip")}
            >
              {t("topbar.mode.solid")}
            </button>
            <button
              className={`sh-tab ${viewMode === "toolpath" ? "active" : ""}`}
              onClick={() => setViewMode("toolpath")}
              title={t("topbar.mode.toolpathTip")}
            >
              {t("topbar.mode.toolpath")}
            </button>
            <button
              className={`sh-tab ${viewMode === "both" ? "active" : ""}`}
              onClick={() => setViewMode("both")}
              title={t("topbar.mode.bothTip")}
            >
              {t("topbar.mode.both")}
            </button>
          </div>

          <div className="sep-v" />

          <button
            className={`sh-btn ghost ${sectionAxis > 0 ? "active" : ""}`}
            onClick={() => {
              if (viewMode === "toolpath") {
                setViewMode("solid");
              }
              setSectionAxis((a) => (a === 0 ? 1 : 0));
            }}
            title={t("topbar.sectionTip")}
          >
            {t("topbar.section")}
          </button>
          <button
            className={`sh-btn ghost ${measureMode ? "active" : ""}`}
            onClick={() => {
              setMeasureMode((m) => {
                if (m) {
                  setPendingP1(null);
                  setHoverWorld(null);
                }
                return !m;
              });
            }}
            title={t("topbar.measureTip")}
          >
            {t("topbar.measure")}
          </button>
          <button
            className={`sh-btn ghost ${viewportLayout !== "single" ? "active" : ""}`}
            onClick={() =>
              setViewportLayout((m) => (m === "quad" ? "single" : "quad"))
            }
            title={t("topbar.quadViewTip")}
          >
            {t("topbar.quadView")}
          </button>
        </div>

        {/* Right Zone: View Options Popover, G-Code Drawer, Export, Language, Theme */}
        <div className="toolbar-right">
          <div className="popover-anchor">
            <button
              type="button"
              className={`sh-btn ghost ${topMenu === "view" ? "active" : ""}`}
              onClick={() => setTopMenu((m) => (m === "view" ? null : "view"))}
              title={t("topbar.viewTip")}
            >
              {t("topbar.view")}
            </button>

            {topMenu === "view" && (
              <div className="sh-popover view-popover">
                <div className="field-row">
                  <span className="popover-row-title">
                    {t("topbar.view.layoutTitle")}
                  </span>
                  <div
                    className="sh-tabs"
                    style={{
                      width: "100%",
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr 1fr",
                    }}
                  >
                    {(
                      [
                        { id: "single", label: t("topbar.view.single") },
                        { id: "dual", label: t("topbar.view.dual") },
                        { id: "quad", label: t("topbar.view.quad") },
                      ] as const
                    ).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`sh-tab ${
                          viewportLayout === item.id ? "active" : ""
                        }`}
                        onClick={() => setViewportLayout(item.id)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="section-divider" />

                <div className="popover-row">
                  <span className="popover-row-title">
                    {t("topbar.view.showCutter")}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showCutter}
                    className={`sh-switch ${showCutter ? "checked" : ""}`}
                    onClick={() => setShowCutter((v) => !v)}
                  >
                    <span className="sh-switch-thumb" />
                  </button>
                </div>

                <div className="popover-row">
                  <span className="popover-row-title">
                    {t("topbar.view.showFloor")}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showFloor}
                    className={`sh-switch ${showFloor ? "checked" : ""}`}
                    onClick={() => setShowFloor((v) => !v)}
                  >
                    <span className="sh-switch-thumb" />
                  </button>
                </div>

                <div className="popover-row">
                  <div className="popover-row-text">
                    <span className="popover-row-title">
                      {t("topbar.view.showRapids")}
                    </span>
                    <span className="popover-row-desc">
                      {t("topbar.view.showRapidsDesc")}
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showRapids}
                    className={`sh-switch ${showRapids ? "checked" : ""}`}
                    onClick={() => setShowRapids((v) => !v)}
                  >
                    <span className="sh-switch-thumb" />
                  </button>
                </div>

                {isTauriRuntime() && (
                  <>
                    <div className="section-divider" />
                    <div className="popover-row">
                      <div className="popover-row-text">
                        <span className="popover-row-title">
                          {t("topbar.view.fileAssoc")}
                        </span>
                        <span className="popover-row-desc">
                          {t("topbar.view.fileAssocDesc")}
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={assocRegistered}
                        className={`sh-switch ${assocRegistered ? "checked" : ""}`}
                        onClick={handleToggleFileAssociations}
                      >
                        <span className="sh-switch-thumb" />
                      </button>
                    </div>
                    <div className="popover-row">
                      <div className="popover-row-text">
                        <span className="popover-row-title">
                          {t("topbar.view.osThumb")}
                        </span>
                        <span className="popover-row-desc">
                          {t("topbar.view.osThumbDesc")}
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={thumbRegistered}
                        className={`sh-switch ${thumbRegistered ? "checked" : ""}`}
                        onClick={handleToggleThumbnails}
                      >
                        <span className="sh-switch-thumb" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <button
            className={`sh-btn ghost ${showGcodePanel ? "active" : ""}`}
            onClick={() => setShowGcodePanel((v) => !v)}
            title={t("topbar.gcodeTip")}
          >
            {t("topbar.gcode")}
          </button>

          <div className="sep-v" />

          <div className="popover-anchor">
            <button
              className={`sh-btn ${topMenu === "export" ? "active" : ""}`}
              onClick={() => setTopMenu((m) => (m === "export" ? null : "export"))}
              title={t("topbar.exportTip")}
            >
              {t("topbar.export")}
            </button>

            {topMenu === "export" && (
              <div className="sh-dropdown-menu export-menu" role="menu">
                <div className="sh-dropdown-label">
                  {t("topbar.export.title")}
                </div>
                <button
                  type="button"
                  className="sh-dropdown-item"
                  onClick={handleExportHdPng}
                >
                  <div className="tool-opt-meta">
                    <span className="tool-opt-title">
                      {t("topbar.export.pngTitle")}
                    </span>
                    <span className="tool-opt-desc">
                      {t("topbar.export.pngDesc")}
                    </span>
                  </div>
                </button>
                <button
                  type="button"
                  className="sh-dropdown-item"
                  onClick={handleExportStlModel}
                >
                  <div className="tool-opt-meta">
                    <span className="tool-opt-title">
                      {t("topbar.export.stlTitle")}
                    </span>
                    <span className="tool-opt-desc">
                      {t("topbar.export.stlDesc")}
                    </span>
                  </div>
                </button>
              </div>
            )}
          </div>

          <LanguageMenu
            isOpen={topMenu === "lang"}
            onToggle={() => setTopMenu((m) => (m === "lang" ? null : "lang"))}
            onClose={() => setTopMenu(null)}
            onToast={showToast}
          />

          <button
            className="sh-btn icon-only"
            onClick={() => setTheme((tMode) => (tMode === "dark" ? "light" : "dark"))}
            title={
              theme === "dark"
                ? t("topbar.theme.toLight")
                : t("topbar.theme.toDark")
            }
          >
            {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      <div
        className="workspace"
        onMouseDown={() => {
          if (topMenu) setTopMenu(null);
        }}
      >
        {/* Resizable Streamlined Left Sidebar: Top Tabs + Body + Pinned Bottom Statusbar */}
        <aside className="left-sidebar" style={{ width: leftWidth }}>
          <div className="sidebar-top-tabs">
            <div
              className="sh-tabs"
              style={{ width: "100%", display: "grid", gridTemplateColumns: "1fr 1fr" }}
            >
              <button
                type="button"
                className={`sh-tab ${leftTab === "params" ? "active" : ""}`}
                onClick={() => setLeftTab("params")}
              >
                {t("sidebar.tab.params")}
              </button>
              <button
                type="button"
                className={`sh-tab ${leftTab === "files" ? "active" : ""}`}
                onClick={() => setLeftTab("files")}
              >
                {t("sidebar.tab.files")}
                {folderFiles.length > 0 ? ` (${folderFiles.length})` : ""}
              </button>
            </div>
          </div>

          {leftTab === "params" ? (
            <div className="sidebar-scroll-body">
              {/* Group 1: Material & Precision */}
              <div className="section-block">
                <div className="inline-form-row">
                  <span className="inline-row-label">{t("params.material")}</span>
                  <div className="inline-row-control">
                    <MaterialSelect
                      materialId={materialId}
                      onSelectMaterial={setMaterialId}
                    />
                  </div>
                </div>
                <div className="inline-form-row">
                  <span className="inline-row-label">{t("params.quality")}</span>
                  <div
                    className="sh-tabs inline-row-control"
                    style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr" }}
                  >
                    {[
                      { res: 512, label: t("params.quality.fast") },
                      { res: 1024, label: t("params.quality.hd") },
                      { res: 1536, label: t("params.quality.ultra") },
                    ].map((item) => (
                      <button
                        key={item.res}
                        className={`sh-tab ${gridMaxDim === item.res ? "active" : ""}`}
                        onClick={() => setGridMaxDim(item.res)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="group-flex-spacer" aria-hidden="true" />

              {/* Group 2: Stock Block, X/Y/Z Dimensions & WCS Datum */}
              <div className="section-block">
                <div className="diagram-wrap-rel">
                  <StockDiagram
                    stock={stock}
                    cutBoundsMin={program?.stats.cut_bounds_min}
                    cutBoundsMax={program?.stats.cut_bounds_max}
                    xyOriginMode={xyOriginMode}
                    zDatumAnchor={zDatumAnchor}
                    materialId={materialId}
                  />
                  {program && !stock.inferred && (
                    <button
                      type="button"
                      className="sh-btn ghost icon-only card-corner-reset"
                      title={t("params.resetStockTip")}
                      onClick={() => setStock(program.stock)}
                    >
                      <RotateCcw size={12} />
                    </button>
                  )}
                </div>

                <div className="dims-grid-3">
                  <CompactDimInput
                    axisLabel={t("params.dimX")}
                    value={stockDims[0]}
                    min={2}
                    max={3000}
                    decimals={1}
                    onChange={handleSizeXChange}
                  />
                  <CompactDimInput
                    axisLabel={t("params.dimY")}
                    value={stockDims[1]}
                    min={2}
                    max={3000}
                    decimals={1}
                    onChange={handleSizeYChange}
                  />
                  <CompactDimInput
                    axisLabel={t("params.dimZ")}
                    value={stockDims[2]}
                    min={0.2}
                    max={500}
                    decimals={2}
                    onChange={handleThicknessChange}
                  />
                </div>

                <div className="inline-form-row">
                  <span className="inline-row-label">{t("params.origin")}</span>
                  <div
                    className="sh-tabs inline-row-control"
                    style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}
                  >
                    <button
                      className={`sh-tab ${xyOriginMode === "center" ? "active" : ""}`}
                      onClick={() => applyXyOriginMode("center")}
                      title={t("params.origin.centerTip")}
                    >
                      {t("params.origin.center")}
                    </button>
                    <button
                      className={`sh-tab ${xyOriginMode === "corner" ? "active" : ""}`}
                      onClick={() => applyXyOriginMode("corner")}
                      title={t("params.origin.cornerTip")}
                    >
                      {t("params.origin.corner")}
                    </button>
                  </div>
                </div>

                <div className="inline-form-row">
                  <span className="inline-row-label">{t("params.datum")}</span>
                  <div
                    className="sh-tabs inline-row-control"
                    style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}
                  >
                    <button
                      className={`sh-tab ${zDatumAnchor === "top" ? "active" : ""}`}
                      onClick={() => applyZDatumAnchor("top")}
                      title={t("params.datum.topTip")}
                    >
                      {t("params.datum.top")}
                    </button>
                    <button
                      className={`sh-tab ${zDatumAnchor === "bottom" ? "active" : ""}`}
                      onClick={() => applyZDatumAnchor("bottom")}
                      title={t("params.datum.bottomTip")}
                    >
                      {t("params.datum.bottom")}
                    </button>
                  </div>
                </div>
              </div>

              <div className="group-flex-spacer" aria-hidden="true" />

              {/* Group 3: Cutter Type & Dimensions */}
              <div className="section-block">
                <div className="inline-form-row">
                  <span className="inline-row-label">{t("params.cutter")}</span>
                  <div className="inline-row-control">
                    <ToolSelect
                      tool={tool}
                      onSelectKind={(nextKind) => {
                        setTool((prev) => ({
                          ...prev,
                          kind: nextKind,
                          tip_radius:
                            nextKind === "ball_nose"
                              ? Number((prev.diameter * 0.5).toFixed(2))
                              : nextKind === "tapered_ball_nose"
                              ? 0.4
                              : nextKind === "bull_nose"
                              ? 0.8
                              : 0.05,
                          half_angle_deg:
                            nextKind === "tapered_ball_nose"
                              ? 3.5
                              : nextKind === "v_bit"
                              ? 30
                              : 0,
                          inferred: false,
                        }));
                      }}
                    />
                  </div>
                  {program && !tool.inferred && (
                    <button
                      type="button"
                      className="sh-btn ghost icon-only"
                      style={{ width: 24, height: 24, flexShrink: 0 }}
                      title={t("params.resetToolTip")}
                      onClick={() => setTool(program.tool)}
                    >
                      <RotateCcw size={12} />
                    </button>
                  )}
                </div>

                <NumericSliderField
                  label={t("params.diameter")}
                  unit="mm"
                  value={tool.diameter}
                  min={0.05}
                  max={120}
                  sliderMin={0.5}
                  sliderMax={25}
                  step={0.125}
                  decimals={3}
                  onChange={(d) => {
                    setTool((prev) => ({
                      ...prev,
                      diameter: d,
                      tip_radius:
                        prev.kind === "ball_nose"
                          ? d * 0.5
                          : Math.min(prev.tip_radius, d * 0.5),
                      inferred: false,
                    }));
                  }}
                />

                {(tool.kind === "tapered_ball_nose" || tool.kind === "bull_nose") && (
                  <NumericSliderField
                    label={t("params.cornerRadius")}
                    unit="mm"
                    value={tool.tip_radius}
                    min={0.01}
                    max={Math.max(tool.diameter * 0.5, 0.05)}
                    sliderMin={0.05}
                    sliderMax={Math.max(tool.diameter * 0.5, 0.2)}
                    step={0.05}
                    decimals={3}
                    onChange={(r) =>
                      setTool((prev) => ({
                        ...prev,
                        tip_radius: Math.min(r, prev.diameter * 0.5),
                        inferred: false,
                      }))
                    }
                  />
                )}

                {(tool.kind === "tapered_ball_nose" || tool.kind === "v_bit") && (
                  <NumericSliderField
                    label={t("params.taperAngle")}
                    unit="°"
                    value={tool.half_angle_deg}
                    min={0.5}
                    max={85}
                    sliderMin={1.0}
                    sliderMax={60.0}
                    step={0.5}
                    decimals={2}
                    onChange={(ang) =>
                      setTool((prev) => ({
                        ...prev,
                        half_angle_deg: ang,
                        inferred: false,
                      }))
                    }
                  />
                )}
              </div>
            </div>
          ) : (
            <FileExplorerPane
              folderFiles={folderFiles}
              activeFileKey={activeFileKey}
              currentFileName={program?.stats.file_name}
              folderFilter={folderFilter}
              darkMode={theme === "dark"}
              viewport={vpRef.current}
              onChangeFilter={setFolderFilter}
              onClearFiles={() => {
                setFolderFiles([]);
                setFolderFilter("");
              }}
              onOpenFileDialog={() => void handleOpenFileDialog()}
              onOpenFolderDialog={() => void handleOpenFolderDialog()}
              onSelectFolderItem={(item) => {
                setActiveFileKey(item.path);
                if (item.browserFile) {
                  void loadBrowserFileObject(item.browserFile, false);
                } else {
                  void loadFileFromPath(item.path, false);
                }
              }}
              onSelectBuiltinSample={(kind) => {
                setActiveFileKey(`builtin:${kind}`);
                void loadSample(kind);
              }}
            />
          )}

          {/* Pinned Left-Sidebar Bottom Status Bar */}
          <footer
            className="sidebar-statusbar"
            title={
              program
                ? t("status.tooltip", {
                    file: program.stats.file_name,
                    x: stockDims[0].toFixed(0),
                    y: stockDims[1].toFixed(0),
                    z: stockDims[2].toFixed(1),
                    ms: program.stats.parse_time_ms.toFixed(1),
                  })
                : t("app.ready")
            }
          >
            <div className="sb-status-left">
              <span className="sb-dot" />
              {program ? (
                <span>
                  {(program.stats.cut_length_mm / 1000).toFixed(1)}m ·{" "}
                  {formatDuration(program.stats.estimated_time_sec)}
                </span>
              ) : (
                <span>{t("app.ready")}</span>
              )}
            </div>
            {program && (
              <span className="sb-status-right">
                {t("status.lines", {
                  count: program.stats.total_lines.toLocaleString(),
                })}
              </span>
            )}
          </footer>
        </aside>

        {/* Left Resizable Splitter */}
        <div
          className={`resize-handle ${resizingSide === "left" ? "dragging" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            setResizingSide("left");
          }}
          title={t("sidebar.resizeLeftTip")}
        />

        {/* Center 3D Viewport */}
        <main className="viewport-wrap" ref={viewportRef}>
          <canvas
            ref={canvasRef}
            className={`viewport-canvas ${measureMode ? "measuring" : ""}`}
            onMouseDown={onCanvasMouseDown}
            onMouseMove={onCanvasMouseMove}
            onMouseUp={onCanvasMouseUp}
            onMouseLeave={onCanvasMouseLeave}
            onWheel={onCanvasWheel}
          />

          {/* 3D Dynamic Cross-Section Plane Control Bar */}
          {sectionAxis > 0 && viewMode !== "toolpath" && (
            <div
              className="section-floating-bar"
              style={{ top: 50 }}
            >
              <div className="sh-tabs">
                <button
                  type="button"
                  className={`sh-tab ${sectionAxis === 1 ? "active" : ""}`}
                  onClick={() => setSectionAxis(1)}
                >
                  {t("section.x")}
                </button>
                <button
                  type="button"
                  className={`sh-tab ${sectionAxis === 2 ? "active" : ""}`}
                  onClick={() => setSectionAxis(2)}
                >
                  {t("section.y")}
                </button>
              </div>
              <input
                type="range"
                className="range-input section-slider"
                min={0.02}
                max={0.98}
                step={0.005}
                value={sectionRatio}
                onChange={(e) => setSectionRatio(parseFloat(e.target.value))}
                title={t("section.sliderTip")}
              />
              <span className="section-coord-readout">
                {sectionAxis === 1 ? "X" : "Y"}{" "}
                {(
                  (sectionAxis === 1 ? stock.min[0] : stock.min[1]) +
                  sectionRatio * (sectionAxis === 1 ? stockDims[0] : stockDims[1])
                ).toFixed(1)}{" "}
                mm
              </span>
              <button
                type="button"
                className="sh-btn ghost icon-only"
                style={{ width: 22, height: 22 }}
                title={t("section.closeTip")}
                onClick={() => setSectionAxis(0)}
              >
                <X size={12} />
              </button>
            </div>
          )}

          {/* 3D CAD Surface Depth & Point-to-Point Measurement Overlay */}
          {(measureMode || measurements.length > 0) && (
            <MeasureOverlay
              stockTopZ={stock.max[2]}
              measurements={measurements}
              pendingP1={measureMode ? pendingP1 : null}
              hoverWorld={measureMode ? hoverWorld : null}
              projectWorld={projectWorldPoint}
              onRemoveMeasurement={(id) =>
                setMeasurements((prev) => prev.filter((item) => item.id !== id))
              }
              onClearAll={() => {
                setMeasurements([]);
                setPendingP1(null);
              }}
            />
          )}

          {/* Blender-Style Dual / Quad Multi-Viewport Splitters & Per-Pane Headers */}
          <MultiViewOverlay
            layout={viewportLayout}
            splitX={splitX}
            splitY={splitY}
            panes={activePanes}
            activePaneId={activePaneId}
            containerRef={viewportRef}
            onChangeSplit={(nx, ny) => {
              setSplitX(nx);
              setSplitY(ny);
            }}
            onSelectPanePreset={handleSelectPanePreset}
            onResetPaneFit={handleResetPaneFit}
            onMaximizePane={handleMaximizePane}
          />

          {/* Subtle Top-Left File Badge + Microscope ROI Resampling Indicator (in Single View) */}
          {program && !measureMode && viewportLayout === "single" && (
            <div className="hud-file-pill">
              <span className="dot" />
              <span>{program.stats.file_name}</span>
              {precisionInfo?.isRoi && viewMode !== "toolpath" && (
                <span className="roi-micro-tag">
                  {t("hud.roiBadge", {
                    um: Math.max(Math.round(precisionInfo.mmPerCell * 1000), 1),
                  })}
                </span>
              )}
            </div>
          )}

          {/* Z-Depth Elevation Heatmap Color Scale Legend */}
          {materialId === 5 && viewMode !== "toolpath" && (
            <div className="heatmap-legend">
              <div className="heatmap-legend-header">
                <span>{t("heatmap.title")}</span>
                <span className="heatmap-sub">{t("heatmap.sub")}</span>
              </div>
              <div className="heatmap-bar" />
              <div className="heatmap-ticks">
                <span>0.0 mm</span>
                <span>-{(stockDims[2] * 0.5).toFixed(1)}</span>
                <span>-{stockDims[2].toFixed(1)} mm</span>
              </div>
            </div>
          )}

          {/* Top-Right Interactive 3D Rotating ViewCube (Faces + 8 Vertices -> Orthographic) */}
          <ViewCube
            yawDeg={camera.yawDeg}
            pitchDeg={camera.pitchDeg}
            isOrtho={Boolean(camera.ortho)}
            onOrbitDelta={(dYaw, dPitch) => {
              cancelAnimationFrame(tweenRafRef.current);
              setCamera((c) => ({
                ...c,
                yawDeg: c.yawDeg + dYaw,
                pitchDeg: Math.min(Math.max(c.pitchDeg + dPitch, -89.2), 89.2),
              }));
            }}
            onSelectOrientation={animateCameraTo}
            onToggleOrtho={() => setCamera((c) => ({ ...c, ortho: !c.ortho }))}
          />

          {gpuError && (
            <div className="drop-mask">
              {t("app.webgpuHint", { error: gpuError })}
            </div>
          )}

          {isDraggingFile && <div className="drop-mask">{t("app.dropMask")}</div>}

          {toast && <div className="toast-banner">{toast}</div>}

          {/* Compact Floating Playback & Single-Step Dock */}
          {program && (
            <div className="hud-dock">
              <div className="dock-transport">
                <button
                  type="button"
                  className="sh-btn icon-only dock-step-btn"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    const jump = Math.max(
                      Math.round(program.stats.segment_count * 0.05),
                      10
                    );
                    stepSegments(e.shiftKey ? -jump : -1, false);
                  }}
                  title={t("dock.stepBackTip")}
                >
                  <ChevronLeft size={14} />
                </button>
                <button
                  type="button"
                  className="sh-btn primary icon-only"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    togglePlay();
                  }}
                  title={isPlaying ? t("dock.pauseTip") : t("dock.playTip")}
                >
                  {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button
                  type="button"
                  className="sh-btn icon-only dock-step-btn"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    const jump = Math.max(
                      Math.round(program.stats.segment_count * 0.05),
                      10
                    );
                    stepSegments(e.shiftKey ? jump : 1, false);
                  }}
                  title={t("dock.stepFwdTip")}
                >
                  <ChevronRight size={14} />
                </button>
              </div>

              <div className="dock-scrubber">
                <input
                  type="range"
                  className="range-input"
                  min={0}
                  max={program.stats.segment_count}
                  value={activeSegs}
                  onChange={(e) => {
                    cancelAnimationFrame(cutterTweenRafRef.current);
                    setCutterOverride(null);
                    setIsPlaying(false);
                    setActiveSegs(Number(e.target.value));
                  }}
                />
                <span className="dock-pct">{progressPct.toFixed(0)}%</span>
              </div>

              <button
                type="button"
                className="dock-line-btn"
                onClick={() => setShowGcodePanel(true)}
                title={t("dock.lineBtnTip")}
              >
                <span className="dock-line-prefix">{t("dock.linePrefix")}</span>
                <span
                  className="dock-line-num"
                  style={{ width: `${lineDigits}ch` }}
                >
                  {tipInfo?.lineNumber ?? 1}
                </span>
              </button>

              <SpeedSelect value={playSpeed} onChange={setPlaySpeed} />

              <div className="xyz-pill">
                <span className="xyz-item">
                  <i className="xyz-ax">X</i>
                  <b style={{ width: `${xyzChars}ch` }}>
                    {(cutterOverride ? cutterOverride[0] : tipInfo?.x ?? 0).toFixed(1)}
                  </b>
                </span>
                <span className="xyz-item">
                  <i className="xyz-ax">Y</i>
                  <b style={{ width: `${xyzChars}ch` }}>
                    {(cutterOverride ? cutterOverride[1] : tipInfo?.y ?? 0).toFixed(1)}
                  </b>
                </span>
                <span className="xyz-item">
                  <i className="xyz-ax">Z</i>
                  <b style={{ width: `${xyzChars}ch` }}>
                    {(cutterOverride ? cutterOverride[2] : tipInfo?.z ?? 0).toFixed(1)}
                  </b>
                </span>
              </div>
            </div>
          )}
        </main>

        {/* Resizable Virtualized Right G-Code Panel */}
        {showGcodePanel && program && (
          <>
            <div
              className={`resize-handle ${resizingSide === "right" ? "dragging" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setResizingSide("right");
              }}
              title={t("sidebar.resizeRightTip")}
            />
            <GcodePanel
              lines={program.preview_lines}
              totalLines={program.stats.total_lines}
              currentLine={tipInfo?.lineNumber ?? 1}
              width={rightWidth}
              onSelectLine={(lineNum) => {
                if (!vpRef.current) return;
                cancelAnimationFrame(cutterTweenRafRef.current);
                setCutterOverride(null);
                setIsPlaying(false);
                setActiveSegs(vpRef.current.findSegmentIndexForLine(lineNum));
              }}
              onClose={() => setShowGcodePanel(false)}
            />
          </>
        )}
      </div>
    </div>
  );
};
