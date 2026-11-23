import {
  CameraState,
  SegmentTipInfo,
  ShadersDto,
  StockSpec,
  TOOL_KIND_CODE,
  ToolSpec,
} from "../types";
import {
  invertMat4,
  lookAtRh,
  mulMat4,
  orthoRhZeroToOne,
  perspectiveRhZeroToOne,
  projectPointToCss,
  unprojectPoint,
} from "./math";
import { WebGl2Viewport } from "./WebGl2Viewport";

export interface ViewportEngine {
  setOnAsyncUpdate(cb: (() => void) | null): void;
  getActivePrecisionInfo(): { mmPerCell: number; isRoi: boolean; subdiv: number };
  uploadSegments(rawBuffer: ArrayBuffer): void;
  getCurrentCutterPos(): [number, number, number];
  getSegmentTip(activeCount: number): SegmentTipInfo | null;
  findSegmentIndexForLine(lineNumber: number): number;
  render(p: ViewportRenderParams): void;
  pickModelPoint(
    localCssX: number,
    localCssY: number,
    showSolid: boolean,
    activeSegments: number
  ): [number, number, number] | null;
  exportBinaryStl(): Promise<{ buffer: ArrayBuffer; triCount: number }>;
  renderThumbnailDataUrl(
    segmentsBuffer: ArrayBuffer,
    stock: StockSpec,
    tool: ToolSpec,
    materialId: number,
    darkMode: boolean
  ): Promise<string>;
  destroy(): void;
}

/**
 * Automatically selects WebGPU on modern Win10/11/macOS/Linux systems, and seamlessly
 * falls back to WebGL 2.0 (DirectX 11 ANGLE / SwiftShader) on Windows 7 WebView2 109 or legacy GPUs.
 */
export async function createViewportEngine(
  canvas: HTMLCanvasElement,
  shaders: ShadersDto,
  onAsyncUpdate?: () => void,
  isDisposed?: () => boolean
): Promise<ViewportEngine> {
  const forceGl2 =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("renderer") === "webgl2";

  if (!forceGl2 && typeof navigator !== "undefined" && navigator.gpu) {
    try {
      return await WebGpuViewport.create(canvas, shaders, onAsyncUpdate, isDisposed);
    } catch (e) {
      if (isDisposed?.()) throw e;
      // Fall through to WebGL2 compatibility engine (e.g. Win7 / D3D11-only driver)
    }
  }
  return WebGl2Viewport.create(canvas, onAsyncUpdate, isDisposed);
}

const MSAA_SAMPLES = 4;
const RENDER_UNIFORM_BYTES = 208; // 16 + 9 * 4 = 52 floats = 208 bytes (fits inside 256-byte dynamic slot)
const MAX_SUB_VIEWS = 4;
const PART_SLOTS_PER_VIEW = 7;
const LINE_SLOTS_PER_VIEW = 3;

export interface SubViewportSpec {
  /** Normalized CSS canvas rect [x, y, w, h] in [0..1], origin at top-left */
  rect: [number, number, number, number];
  camera: CameraState;
}

export interface ViewportRenderParams {
  stock: StockSpec;
  tool: ToolSpec;
  materialId: number;
  gridMaxDim: number;
  activeSegments: number;
  showSolid: boolean;
  showCutsOverlay: boolean;
  showRapidsOverlay: boolean;
  showStockBox: boolean;
  showCutter: boolean;
  showFloor: boolean;
  darkMode: boolean;
  camera: CameraState;
  subViewports?: SubViewportSpec[];
  cutterOverride?: [number, number, number] | null;
  wcsOrigin?: [number, number, number];
  sectionAxis?: 0 | 1 | 2;
  sectionRatio?: number;
}

interface RoiPatchState {
  simKey: string;
  ix0: number;
  iy0: number;
  ix1: number;
  iy1: number;
  minX: number;
  minY: number;
  roiW: number;
  roiH: number;
  cellDx: number;
  cellDy: number;
  subdiv: number;
}

export class WebGpuViewport implements ViewportEngine {
  private canvas: HTMLCanvasElement;
  private device!: GPUDevice;
  private ctx!: GPUCanvasContext;
  private format!: GPUTextureFormat;

  private simBgl!: GPUBindGroupLayout;
  private initPipeline!: GPUComputePipeline;
  private carvePipeline!: GPUComputePipeline;

  private partBgl!: GPUBindGroupLayout;
  private partPipeline!: GPURenderPipeline;

  private lineBgl!: GPUBindGroupLayout;
  private linePipeline!: GPURenderPipeline;

  private segBuffer: GPUBuffer | null = null;
  private heightBuffer: GPUBuffer | null = null;
  private partUniformBuf!: GPUBuffer;
  private lineUniformBuf!: GPUBuffer;
  private uniformStride = 256;

  private msaaTex: GPUTexture | null = null;
  private msaaView: GPUTextureView | null = null;
  private depthTex: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;
  private texW = 0;
  private texH = 0;

  // Raw segment mirror on CPU for instant O(1) XYZ & lineNumber lookup during scrubbing
  private segFloats: Float32Array = new Float32Array(0);
  private segUints: Uint32Array = new Uint32Array(0);
  private totalSegments = 0;

  // Incremental simulation tracking (carves ONLY new delta moves during forward playback!)
  private gridW = 0;
  private gridH = 0;
  private cellDx = 0.1;
  private cellDy = 0.1;
  private simulatedUpTo = -1;
  private lastSimSignature = "";
  private lastCutterWorldPos: [number, number, number] = [0, 0, 15];

  // Zoom-triggered Adaptive Ultra-HD ROI Microscope Patch
  private roiHeightBuffer: GPUBuffer | null = null;
  private roiBufferCapBytes = 0;
  private roiState: RoiPatchState | null = null;
  private roiTimer: number | null = null;
  private pendingRoiKey = "";
  private onAsyncUpdate: (() => void) | null = null;

  // CPU mirror of heightfield & matrices for sub-millimeter 3D measurement ray-picking & STL export
  private cpuHeights: Int32Array = new Int32Array(0);
  private cpuHeightsDirty = true;
  private readbackBusy = false;
  private lastStock: StockSpec = { min: [-42, -42, -14], max: [42, 42, 0], inferred: true };
  private lastViewProj: Float32Array = new Float32Array(16);
  private lastInvViewProj: Float32Array | null = null;
  private lastRenderedViews: Array<{
    cssX: number;
    cssY: number;
    cssW: number;
    cssH: number;
    viewProj: Float32Array;
    invViewProj: Float32Array | null;
  }> = [];
  private lastSectionAxis: 0 | 1 | 2 = 0;
  private lastSectionPos = 0;

  // Offscreen Studio Card Thumbnail Renderer (shared device & pipelines, zero interference with main view)
  private thumbCanvas: HTMLCanvasElement | null = null;
  private thumbCtx: GPUCanvasContext | null = null;
  private thumbMsaaView: GPUTextureView | null = null;
  private thumbDepthView: GPUTextureView | null = null;
  private thumbMsaaTex: GPUTexture | null = null;
  private thumbDepthTex: GPUTexture | null = null;
  private thumbPartUniformBuf: GPUBuffer | null = null;
  private thumbQueue: Promise<void> = Promise.resolve();

  private constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  static async create(
    canvas: HTMLCanvasElement,
    shaders: ShadersDto,
    onAsyncUpdate?: () => void,
    isDisposed?: () => boolean
  ): Promise<WebGpuViewport> {
    if (!navigator.gpu) {
      throw new Error("当前系统 WebView 未开启 WebGPU 支持");
    }
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) {
      throw new Error("无法获取 GPU 适配器");
    }

    const maxStorage = Math.min(
      adapter.limits.maxStorageBufferBindingSize || 268435456,
      512 * 1024 * 1024
    );
    const maxBuf = Math.min(adapter.limits.maxBufferSize || 268435456, 512 * 1024 * 1024);

    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: maxStorage,
        maxBufferSize: maxBuf,
      },
    });

    if (isDisposed?.()) {
      device.destroy();
      throw new Error("WebGPU init cancelled by StrictMode cleanup");
    }

    const vp = new WebGpuViewport(canvas);
    vp.device = device;
    vp.onAsyncUpdate = onAsyncUpdate ?? null;
    const ctx = canvas.getContext("webgpu") as unknown as GPUCanvasContext | null;
    if (!ctx) {
      throw new Error("无法创建 WebGPU 画布上下文");
    }
    vp.ctx = ctx;
    vp.format = navigator.gpu.getPreferredCanvasFormat();
    vp.ctx.configure({
      device,
      format: vp.format,
      alphaMode: "opaque",
    });

    vp.uniformStride = Math.max(device.limits.minUniformBufferOffsetAlignment || 256, 256);
    vp.initPipelines(shaders);
    return vp;
  }

  setOnAsyncUpdate(cb: (() => void) | null) {
    this.onAsyncUpdate = cb;
  }

  getActivePrecisionInfo(): { mmPerCell: number; isRoi: boolean; subdiv: number } {
    if (this.roiState) {
      return {
        mmPerCell: Math.min(this.roiState.cellDx, this.roiState.cellDy),
        isRoi: true,
        subdiv: this.roiState.subdiv,
      };
    }
    return {
      mmPerCell: Math.min(this.cellDx, this.cellDy),
      isRoi: false,
      subdiv: 1,
    };
  }

  private initPipelines(shaders: ShadersDto) {
    const simMod = this.device.createShaderModule({
      label: "sim_3axis",
      code: shaders.sim_wgsl,
    });
    const partMod = this.device.createShaderModule({
      label: "studio_part",
      code: shaders.studio_part_wgsl,
    });
    const lineMod = this.device.createShaderModule({
      label: "toolpath",
      code: shaders.toolpath_wgsl,
    });

    this.simBgl = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
      ],
    });

    const simPl = this.device.createPipelineLayout({
      bindGroupLayouts: [this.simBgl],
    });

    this.initPipeline = this.device.createComputePipeline({
      layout: simPl,
      compute: { module: simMod, entryPoint: "init_stock_grid" },
    });
    this.carvePipeline = this.device.createComputePipeline({
      layout: simPl,
      compute: { module: simMod, entryPoint: "carve_segments" },
    });

    this.partBgl = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {
            type: "uniform",
            hasDynamicOffset: true,
            minBindingSize: RENDER_UNIFORM_BYTES,
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
      ],
    });

    this.partPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.partBgl] }),
      vertex: { module: partMod, entryPoint: "vs_main" },
      fragment: {
        module: partMod,
        entryPoint: "fs_main",
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
      multisample: { count: MSAA_SAMPLES },
    });

    this.lineBgl = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {
            type: "uniform",
            hasDynamicOffset: true,
            minBindingSize: 128,
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "read-only-storage" },
        },
      ],
    });

    this.linePipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.lineBgl] }),
      vertex: { module: lineMod, entryPoint: "vs_main" },
      fragment: {
        module: lineMod,
        entryPoint: "fs_main",
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "line-list" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
      multisample: { count: MSAA_SAMPLES },
    });

    // 7 dynamic slots per view * up to 4 simultaneous sub-viewports (Blender Quad View!)
    this.partUniformBuf = this.device.createBuffer({
      label: "part_uniforms_multiview",
      size: this.uniformStride * PART_SLOTS_PER_VIEW * MAX_SUB_VIEWS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.lineUniformBuf = this.device.createBuffer({
      label: "line_uniforms_multiview",
      size: this.uniformStride * LINE_SLOTS_PER_VIEW * MAX_SUB_VIEWS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Placeholder 1-segment buffer
    this.uploadSegments(new ArrayBuffer(32));
  }

  uploadSegments(rawBuffer: ArrayBuffer) {
    if (this.segBuffer) {
      this.segBuffer.destroy();
    }
    const byteLen = Math.max(rawBuffer.byteLength, 32);
    const alignedBuf =
      rawBuffer.byteLength >= 32 ? rawBuffer : new ArrayBuffer(32);

    this.totalSegments = Math.floor(rawBuffer.byteLength / 32);
    this.segFloats = new Float32Array(alignedBuf);
    this.segUints = new Uint32Array(alignedBuf);

    this.segBuffer = this.device.createBuffer({
      label: "gpu_segments",
      size: byteLen,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.segBuffer, 0, alignedBuf);
    this.simulatedUpTo = -1;
    this.lastSimSignature = "";
    this.roiState = null;
    this.pendingRoiKey = "";
  }

  getCurrentCutterPos(): [number, number, number] {
    return [...this.lastCutterWorldPos];
  }

  getSegmentTip(activeCount: number): SegmentTipInfo | null {
    if (this.totalSegments === 0) {
      return null;
    }
    if (activeCount <= 0) {
      const kind0 = this.segUints[3];
      return {
        x: this.segFloats[0],
        y: this.segFloats[1],
        z: this.segFloats[2],
        lineNumber: Math.max(1, this.segUints[7]),
        isCut: (kind0 & 0xff) !== 0,
        feedrate: (kind0 >>> 16) * 2.0,
      };
    }
    const idx = Math.min(activeCount - 1, this.totalSegments - 1);
    const base = idx * 8;
    const kindAndTool = this.segUints[base + 3];
    return {
      x: this.segFloats[base + 4],
      y: this.segFloats[base + 5],
      z: this.segFloats[base + 6],
      lineNumber: this.segUints[base + 7],
      isCut: (kindAndTool & 0xff) !== 0,
      feedrate: (kindAndTool >>> 16) * 2.0,
    };
  }

  findSegmentIndexForLine(lineNumber: number): number {
    if (this.totalSegments === 0) return 0;
    let lo = 0;
    let hi = this.totalSegments - 1;
    let ans = this.totalSegments;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const ln = this.segUints[mid * 8 + 7];
      if (ln >= lineNumber) {
        ans = mid + 1;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return Math.min(Math.max(ans, 1), this.totalSegments);
  }

  private ensureAttachments(w: number, h: number) {
    if (w === this.texW && h === this.texH && this.msaaView && this.depthView) {
      return;
    }
    this.msaaTex?.destroy();
    this.depthTex?.destroy();

    this.msaaTex = this.device.createTexture({
      size: { width: w, height: h, depthOrArrayLayers: 1 },
      sampleCount: MSAA_SAMPLES,
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.msaaView = this.msaaTex.createView();

    this.depthTex = this.device.createTexture({
      size: { width: w, height: h, depthOrArrayLayers: 1 },
      sampleCount: MSAA_SAMPLES,
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTex.createView();
    this.texW = w;
    this.texH = h;
  }

  private updateSimulationIfNeeded(encoder: GPUCommandEncoder, p: ViewportRenderParams) {
    const sx = Math.max(p.stock.max[0] - p.stock.min[0], 0.5);
    const sy = Math.max(p.stock.max[1] - p.stock.min[1], 0.5);
    const maxDim = Math.min(Math.max(p.gridMaxDim, 256), 2048);
    const scale = maxDim / Math.max(sx, sy);
    const gw = Math.min(Math.max(Math.round(sx * scale), 64), 2048);
    const gh = Math.min(Math.max(Math.round(sy * scale), 64), 2048);
    const cellDx = sx / (gw - 1);
    const cellDy = sy / (gh - 1);

    const sig = [
      gw,
      gh,
      p.stock.min.join(","),
      p.stock.max.join(","),
      p.tool.kind,
      p.tool.diameter.toFixed(4),
      p.tool.tip_radius.toFixed(4),
      p.tool.half_angle_deg.toFixed(4),
    ].join("|");

    const targetSegs = Math.min(Math.max(p.activeSegments, 0), this.totalSegments);

    const gridRecreated = gw !== this.gridW || gh !== this.gridH || !this.heightBuffer;
    if (gridRecreated) {
      this.heightBuffer?.destroy();
      this.heightBuffer = this.device.createBuffer({
        label: "heights_atomic_buf",
        size: gw * gh * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      this.gridW = gw;
      this.gridH = gh;
    }
    this.cellDx = cellDx;
    this.cellDy = cellDy;

    const fullReset = gridRecreated || sig !== this.lastSimSignature || targetSegs < this.simulatedUpTo;
    if (!fullReset && targetSegs === this.simulatedUpTo) {
      return; // Zero compute needed this frame!
    }

    const startOffset = fullReset ? 0 : Math.max(this.simulatedUpTo, 0);
    const chunkMax = 65535 * 64;
    const remaining = targetSegs - startOffset;
    const numChunks = Math.max(Math.ceil(remaining / chunkMax), 1);

    for (let c = 0; c < numChunks; c++) {
      const segOffset = startOffset + c * chunkMax;
      const buf = new ArrayBuffer(64);
      const f32 = new Float32Array(buf);
      const u32 = new Uint32Array(buf);

      f32[0] = p.stock.min[0];
      f32[1] = p.stock.min[1];
      f32[2] = p.stock.min[2];
      f32[3] = p.stock.max[2];

      f32[4] = p.stock.max[0];
      f32[5] = p.stock.max[1];
      f32[6] = cellDx;
      f32[7] = cellDy;

      u32[8] = gw;
      u32[9] = gh;
      u32[10] = targetSegs;
      u32[11] = segOffset;

      u32[12] = TOOL_KIND_CODE[p.tool.kind] ?? 0;
      f32[13] = Math.max(p.tool.diameter * 0.5, 0.05);
      f32[14] = p.tool.tip_radius;
      f32[15] = (p.tool.half_angle_deg * Math.PI) / 180.0;

      const paramBuf = this.device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(paramBuf, 0, buf);

      const bg = this.device.createBindGroup({
        layout: this.simBgl,
        entries: [
          { binding: 0, resource: { buffer: paramBuf } },
          { binding: 1, resource: { buffer: this.segBuffer! } },
          { binding: 2, resource: { buffer: this.heightBuffer! } },
        ],
      });

      const cpass = encoder.beginComputePass();
      if (fullReset && c === 0) {
        cpass.setPipeline(this.initPipeline);
        cpass.setBindGroup(0, bg);
        cpass.dispatchWorkgroups(Math.ceil(gw / 16), Math.ceil(gh / 16), 1);
      }
      if (targetSegs > segOffset) {
        const countThisChunk = Math.min(targetSegs - segOffset, chunkMax);
        cpass.setPipeline(this.carvePipeline);
        cpass.setBindGroup(0, bg);
        cpass.dispatchWorkgroups(Math.ceil(countThisChunk / 64), 1, 1);
      }
      cpass.end();
    }

    this.lastSimSignature = sig;
    this.simulatedUpTo = targetSegs;
    this.cpuHeightsDirty = true;
    // Invalidate stale ROI patch when simulation target or geometry changes
    if (this.roiState && !this.roiState.simKey.startsWith(`${sig}|${targetSegs}|`)) {
      this.roiState = null;
    }
  }

  private updateRoiSchedule(p: ViewportRenderParams) {
    if (!p.showSolid || p.camera.zoom < 2.25 || this.gridW < 16 || this.gridH < 16) {
      if (this.roiTimer !== null) {
        window.clearTimeout(this.roiTimer);
        this.roiTimer = null;
      }
      this.pendingRoiKey = "";
      this.roiState = null;
      return;
    }

    const smin = p.stock.min;
    const smax = p.stock.max;
    const sx = Math.max(smax[0] - smin[0], 1.0);
    const sy = Math.max(smax[1] - smin[1], 1.0);
    const focusX = 0.5 * (smin[0] + smax[0]) + p.camera.panX;
    const focusY = 0.5 * (smin[1] + smax[1]) + p.camera.panY;
    const roiHalf = Math.max((Math.max(sx, sy) * 0.62) / p.camera.zoom, 2.5);

    const ix0 = Math.min(
      Math.max(Math.floor((focusX - roiHalf - smin[0]) / this.cellDx), 0),
      this.gridW - 9
    );
    const ix1 = Math.min(
      Math.max(Math.ceil((focusX + roiHalf - smin[0]) / this.cellDx), ix0 + 8),
      this.gridW - 1
    );
    const iy0 = Math.min(
      Math.max(Math.floor((focusY - roiHalf - smin[1]) / this.cellDy), 0),
      this.gridH - 9
    );
    const iy1 = Math.min(
      Math.max(Math.ceil((focusY + roiHalf - smin[1]) / this.cellDy), iy0 + 8),
      this.gridH - 1
    );

    const baseSpanCells = Math.max(ix1 - ix0, iy1 - iy0);
    const subdiv = Math.min(Math.max(Math.floor(896 / baseSpanCells), 1), 12);
    if (subdiv < 2) {
      return;
    }

    const targetSegs = Math.min(Math.max(p.activeSegments, 0), this.totalSegments);
    const desiredKey = `${this.lastSimSignature}|${targetSegs}|${ix0},${iy0},${ix1},${iy1},${subdiv}`;

    if (this.roiState && this.roiState.simKey === desiredKey) {
      return;
    }
    if (this.pendingRoiKey === desiredKey && this.roiTimer !== null) {
      return;
    }

    if (this.roiTimer !== null) {
      window.clearTimeout(this.roiTimer);
    }
    this.pendingRoiKey = desiredKey;

    const snapStock: StockSpec = {
      min: [...p.stock.min] as [number, number, number],
      max: [...p.stock.max] as [number, number, number],
      inferred: p.stock.inferred,
    };
    const snapTool: ToolSpec = { ...p.tool };

    this.roiTimer = window.setTimeout(() => {
      this.roiTimer = null;
      this.pendingRoiKey = "";
      this.executeRoiCarve(
        desiredKey,
        ix0,
        iy0,
        ix1,
        iy1,
        subdiv,
        targetSegs,
        snapStock,
        snapTool
      );
    }, 170);
  }

  private executeRoiCarve(
    simKey: string,
    ix0: number,
    iy0: number,
    ix1: number,
    iy1: number,
    subdiv: number,
    targetSegs: number,
    stock: StockSpec,
    tool: ToolSpec
  ) {
    if (!this.segBuffer) return;

    const roiW = (ix1 - ix0) * subdiv + 1;
    const roiH = (iy1 - iy0) * subdiv + 1;
    const minX = stock.min[0] + ix0 * this.cellDx;
    const maxX = stock.min[0] + ix1 * this.cellDx;
    const minY = stock.min[1] + iy0 * this.cellDy;
    const maxY = stock.min[1] + iy1 * this.cellDy;
    const roiDx = this.cellDx / subdiv;
    const roiDy = this.cellDy / subdiv;

    const neededBytes = roiW * roiH * 4;
    if (!this.roiHeightBuffer || this.roiBufferCapBytes < neededBytes) {
      this.roiHeightBuffer?.destroy();
      this.roiBufferCapBytes = Math.max(neededBytes, 1025 * 1025 * 4);
      this.roiHeightBuffer = this.device.createBuffer({
        label: "roi_ultra_hd_heights",
        size: this.roiBufferCapBytes,
        usage: GPUBufferUsage.STORAGE,
      });
    }

    const enc = this.device.createCommandEncoder();
    const chunkMax = 65535 * 64;
    const numChunks = Math.max(Math.ceil(targetSegs / chunkMax), 1);

    for (let c = 0; c < numChunks; c++) {
      const segOffset = c * chunkMax;
      const buf = new ArrayBuffer(64);
      const f32 = new Float32Array(buf);
      const u32 = new Uint32Array(buf);

      f32[0] = minX;
      f32[1] = minY;
      f32[2] = stock.min[2];
      f32[3] = stock.max[2];

      f32[4] = maxX;
      f32[5] = maxY;
      f32[6] = roiDx;
      f32[7] = roiDy;

      u32[8] = roiW;
      u32[9] = roiH;
      u32[10] = targetSegs;
      u32[11] = segOffset;

      u32[12] = TOOL_KIND_CODE[tool.kind] ?? 0;
      f32[13] = Math.max(tool.diameter * 0.5, 0.05);
      f32[14] = tool.tip_radius;
      f32[15] = (tool.half_angle_deg * Math.PI) / 180.0;

      const paramBuf = this.device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(paramBuf, 0, buf);

      const bg = this.device.createBindGroup({
        layout: this.simBgl,
        entries: [
          { binding: 0, resource: { buffer: paramBuf } },
          { binding: 1, resource: { buffer: this.segBuffer } },
          { binding: 2, resource: { buffer: this.roiHeightBuffer } },
        ],
      });

      const cpass = enc.beginComputePass();
      if (c === 0) {
        cpass.setPipeline(this.initPipeline);
        cpass.setBindGroup(0, bg);
        cpass.dispatchWorkgroups(Math.ceil(roiW / 16), Math.ceil(roiH / 16), 1);
      }
      if (targetSegs > segOffset) {
        const countThisChunk = Math.min(targetSegs - segOffset, chunkMax);
        cpass.setPipeline(this.carvePipeline);
        cpass.setBindGroup(0, bg);
        cpass.dispatchWorkgroups(Math.ceil(countThisChunk / 64), 1, 1);
      }
      cpass.end();
    }

    this.device.queue.submit([enc.finish()]);
    this.roiState = {
      simKey,
      ix0,
      iy0,
      ix1,
      iy1,
      minX,
      minY,
      roiW,
      roiH,
      cellDx: roiDx,
      cellDy: roiDy,
      subdiv,
    };
    this.onAsyncUpdate?.();
  }

  private scheduleHeightReadbackIfNeeded() {
    if (!this.cpuHeightsDirty || this.readbackBusy || !this.heightBuffer) {
      return;
    }
    const byteSize = this.gridW * this.gridH * 4;
    if (byteSize <= 0) return;

    this.readbackBusy = true;
    this.cpuHeightsDirty = false;
    const srcBuf = this.heightBuffer;
    const expectedW = this.gridW;
    const expectedH = this.gridH;

    const staging = this.device.createBuffer({
      label: "measure_readback_staging",
      size: byteSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(srcBuf, 0, staging, 0, byteSize);
    this.device.queue.submit([enc.finish()]);

    staging
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        if (expectedW === this.gridW && expectedH === this.gridH) {
          const mapped = staging.getMappedRange();
          this.cpuHeights = new Int32Array(mapped.slice(0));
        }
        staging.unmap();
        staging.destroy();
        this.readbackBusy = false;
      })
      .catch(() => {
        try {
          staging.destroy();
        } catch {}
        this.readbackBusy = false;
      });
  }

  /**
   * Reconstruct a watertight Binary `.STL` 3D mesh buffer directly from the simulated WebGPU heightfield.
   */
  async exportBinaryStl(): Promise<{ buffer: ArrayBuffer; triCount: number }> {
    if (!this.heightBuffer || this.gridW < 2 || this.gridH < 2) {
      throw new Error("当前尚无有效的三维仿真网格数据");
    }

    const gw = this.gridW;
    const gh = this.gridH;
    const byteSize = gw * gh * 4;

    // Perform an explicit fresh readback so STL always reflects the exact current heightfield
    const staging = this.device.createBuffer({
      label: "stl_export_readback",
      size: byteSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.heightBuffer, 0, staging, 0, byteSize);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const heightsI32 = new Int32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();

    const smin = this.lastStock.min;
    const smax = this.lastStock.max;
    const dx = this.cellDx;
    const dy = this.cellDy;
    const cellsX = gw - 1;
    const cellsY = gh - 1;
    const pierceZ = smin[2] - 0.03;

    const solid = new Uint8Array(cellsX * cellsY);
    for (let qy = 0; qy < cellsY; qy++) {
      for (let qx = 0; qx < cellsX; qx++) {
        const r00 = heightsI32[qy * gw + qx] / 10000.0;
        const r10 = heightsI32[qy * gw + qx + 1] / 10000.0;
        const r01 = heightsI32[(qy + 1) * gw + qx] / 10000.0;
        const r11 = heightsI32[(qy + 1) * gw + qx + 1] / 10000.0;
        const pierced = r00 < pierceZ && r10 < pierceZ && r01 < pierceZ && r11 < pierceZ;
        solid[qy * cellsX + qx] = pierced ? 0 : 1;
      }
    }

    const isSolid = (qx: number, qy: number): boolean => {
      if (qx < 0 || qy < 0 || qx >= cellsX || qy >= cellsY) return false;
      return solid[qy * cellsX + qx] === 1;
    };

    let triCount = 0;
    for (let qy = 0; qy < cellsY; qy++) {
      for (let qx = 0; qx < cellsX; qx++) {
        if (!solid[qy * cellsX + qx]) continue;
        triCount += 4;
        if (!isSolid(qx, qy - 1)) triCount += 2;
        if (!isSolid(qx, qy + 1)) triCount += 2;
        if (!isSolid(qx - 1, qy)) triCount += 2;
        if (!isSolid(qx + 1, qy)) triCount += 2;
      }
    }

    const outBuf = new ArrayBuffer(84 + triCount * 50);
    const u8 = new Uint8Array(outBuf);
    const title = "ShibaNC Watertight 3-Axis Machined Mesh (Units: mm)";
    for (let i = 0; i < title.length; i++) {
      u8[i] = title.charCodeAt(i);
    }
    const dv = new DataView(outBuf);
    dv.setUint32(80, triCount, true);

    let offset = 84;
    const writeTri = (
      ax: number,
      ay: number,
      az: number,
      bx: number,
      by: number,
      bz: number,
      cx: number,
      cy: number,
      cz: number
    ) => {
      const ux = bx - ax;
      const uy = by - ay;
      const uz = bz - az;
      const vx = cx - ax;
      const vy = cy - ay;
      const vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1.0;
      nx /= nl;
      ny /= nl;
      nz /= nl;

      dv.setFloat32(offset, nx, true);
      dv.setFloat32(offset + 4, ny, true);
      dv.setFloat32(offset + 8, nz, true);
      dv.setFloat32(offset + 12, ax, true);
      dv.setFloat32(offset + 16, ay, true);
      dv.setFloat32(offset + 20, az, true);
      dv.setFloat32(offset + 24, bx, true);
      dv.setFloat32(offset + 28, by, true);
      dv.setFloat32(offset + 32, bz, true);
      dv.setFloat32(offset + 36, cx, true);
      dv.setFloat32(offset + 40, cy, true);
      dv.setFloat32(offset + 44, cz, true);
      dv.setUint16(offset + 48, 0, true);
      offset += 50;
    };

    const clampedZ = (ix: number, iy: number): number => {
      const z = heightsI32[iy * gw + ix] / 10000.0;
      return Math.min(Math.max(z, smin[2]), smax[2]);
    };

    const zBot = smin[2];
    for (let qy = 0; qy < cellsY; qy++) {
      const y0 = smin[1] + qy * dy;
      const y1 = y0 + dy;
      for (let qx = 0; qx < cellsX; qx++) {
        if (!solid[qy * cellsX + qx]) continue;
        const x0 = smin[0] + qx * dx;
        const x1 = x0 + dx;
        const z00 = clampedZ(qx, qy);
        const z10 = clampedZ(qx + 1, qy);
        const z01 = clampedZ(qx, qy + 1);
        const z11 = clampedZ(qx + 1, qy + 1);

        // Top
        if (Math.abs(z11 - z00) <= Math.abs(z10 - z01)) {
          writeTri(x0, y0, z00, x1, y0, z10, x1, y1, z11);
          writeTri(x0, y0, z00, x1, y1, z11, x0, y1, z01);
        } else {
          writeTri(x0, y0, z00, x1, y0, z10, x0, y1, z01);
          writeTri(x1, y0, z10, x1, y1, z11, x0, y1, z01);
        }

        // Bottom (-Z)
        writeTri(x0, y0, zBot, x1, y1, zBot, x1, y0, zBot);
        writeTri(x0, y0, zBot, x0, y1, zBot, x1, y1, zBot);

        // Boundary & through-hole vertical walls
        if (!isSolid(qx, qy - 1)) {
          writeTri(x0, y0, zBot, x1, y0, zBot, x1, y0, z10);
          writeTri(x0, y0, zBot, x1, y0, z10, x0, y0, z00);
        }
        if (!isSolid(qx, qy + 1)) {
          writeTri(x1, y1, zBot, x0, y1, zBot, x0, y1, z01);
          writeTri(x1, y1, zBot, x0, y1, z01, x1, y1, z11);
        }
        if (!isSolid(qx - 1, qy)) {
          writeTri(x0, y1, zBot, x0, y0, zBot, x0, y0, z00);
          writeTri(x0, y1, zBot, x0, y0, z00, x0, y1, z01);
        }
        if (!isSolid(qx + 1, qy)) {
          writeTri(x1, y0, zBot, x1, y1, zBot, x1, y1, z11);
          writeTri(x1, y0, zBot, x1, y1, z11, x1, y0, z10);
        }
      }
    }

    return { buffer: outBuf, triCount };
  }

  /**
   * Render an isolated 320x200 4x MSAA studio preview thumbnail DataURL for any G-code segment buffer.
   */
  renderThumbnailDataUrl(
    segmentsBuffer: ArrayBuffer,
    stock: StockSpec,
    tool: ToolSpec,
    materialId: number,
    darkMode: boolean
  ): Promise<string> {
    const job = this.thumbQueue.then(
      () =>
        new Promise<string>((resolve) => {
          requestAnimationFrame(() => {
            try {
              resolve(
                this.renderThumbnailSync(
                  segmentsBuffer,
                  stock,
                  tool,
                  materialId,
                  darkMode
                )
              );
            } catch {
              resolve("");
            }
          });
        })
    );
    this.thumbQueue = job.then(
      () => undefined,
      () => undefined
    );
    return job;
  }

  private renderThumbnailSync(
    segmentsBuffer: ArrayBuffer,
    stock: StockSpec,
    tool: ToolSpec,
    materialId: number,
    darkMode: boolean
  ): string {
    const tw = 320;
    const th = 200;
    if (!this.thumbCanvas || !this.thumbCtx || !this.thumbMsaaView || !this.thumbDepthView || !this.thumbPartUniformBuf) {
      const cvs = document.createElement("canvas");
      cvs.width = tw;
      cvs.height = th;
      const tctx = cvs.getContext("webgpu") as unknown as GPUCanvasContext | null;
      if (!tctx) {
        return "";
      }
      tctx.configure({
        device: this.device,
        format: this.format,
        alphaMode: "opaque",
      });
      this.thumbCanvas = cvs;
      this.thumbCtx = tctx;

      this.thumbMsaaTex = this.device.createTexture({
        size: { width: tw, height: th, depthOrArrayLayers: 1 },
        sampleCount: MSAA_SAMPLES,
        format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.thumbMsaaView = this.thumbMsaaTex.createView();

      this.thumbDepthTex = this.device.createTexture({
        size: { width: tw, height: th, depthOrArrayLayers: 1 },
        sampleCount: MSAA_SAMPLES,
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.thumbDepthView = this.thumbDepthTex.createView();

      this.thumbPartUniformBuf = this.device.createBuffer({
        label: "thumb_part_uniforms",
        size: this.uniformStride * 5,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    const totalSegs = Math.floor(segmentsBuffer.byteLength / 32);
    const alignedSegs =
      segmentsBuffer.byteLength >= 32 ? segmentsBuffer : new ArrayBuffer(32);

    const tSegBuf = this.device.createBuffer({
      size: Math.max(alignedSegs.byteLength, 32),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(tSegBuf, 0, alignedSegs);

    const sx = Math.max(stock.max[0] - stock.min[0], 0.5);
    const sy = Math.max(stock.max[1] - stock.min[1], 0.5);
    const sz = Math.max(stock.max[2] - stock.min[2], 0.2);
    const scale = 288 / Math.max(sx, sy);
    const gw = Math.min(Math.max(Math.round(sx * scale), 64), 320);
    const gh = Math.min(Math.max(Math.round(sy * scale), 64), 320);
    const cellDx = sx / (gw - 1);
    const cellDy = sy / (gh - 1);

    const tHeightBuf = this.device.createBuffer({
      size: gw * gh * 4,
      usage: GPUBufferUsage.STORAGE,
    });

    const enc = this.device.createCommandEncoder();
    const chunkMax = 65535 * 64;
    const numChunks = Math.max(Math.ceil(totalSegs / chunkMax), 1);

    for (let c = 0; c < numChunks; c++) {
      const segOffset = c * chunkMax;
      const pbuf = new ArrayBuffer(64);
      const f32 = new Float32Array(pbuf);
      const u32 = new Uint32Array(pbuf);

      f32[0] = stock.min[0];
      f32[1] = stock.min[1];
      f32[2] = stock.min[2];
      f32[3] = stock.max[2];
      f32[4] = stock.max[0];
      f32[5] = stock.max[1];
      f32[6] = cellDx;
      f32[7] = cellDy;
      u32[8] = gw;
      u32[9] = gh;
      u32[10] = totalSegs;
      u32[11] = segOffset;
      u32[12] = TOOL_KIND_CODE[tool.kind] ?? 0;
      f32[13] = Math.max(tool.diameter * 0.5, 0.05);
      f32[14] = tool.tip_radius;
      f32[15] = (tool.half_angle_deg * Math.PI) / 180.0;

      const simParamBuf = this.device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(simParamBuf, 0, pbuf);

      const simBg = this.device.createBindGroup({
        layout: this.simBgl,
        entries: [
          { binding: 0, resource: { buffer: simParamBuf } },
          { binding: 1, resource: { buffer: tSegBuf } },
          { binding: 2, resource: { buffer: tHeightBuf } },
        ],
      });

      const cpass = enc.beginComputePass();
      if (c === 0) {
        cpass.setPipeline(this.initPipeline);
        cpass.setBindGroup(0, simBg);
        cpass.dispatchWorkgroups(Math.ceil(gw / 16), Math.ceil(gh / 16), 1);
      }
      if (totalSegs > segOffset) {
        const cnt = Math.min(totalSegs - segOffset, chunkMax);
        cpass.setPipeline(this.carvePipeline);
        cpass.setBindGroup(0, simBg);
        cpass.dispatchWorkgroups(Math.ceil(cnt / 64), 1, 1);
      }
      cpass.end();
    }

    // Studio camera framing
    const center: [number, number, number] = [
      0.5 * (stock.min[0] + stock.max[0]),
      0.5 * (stock.min[1] + stock.max[1]),
      0.5 * (stock.min[2] + stock.max[2]),
    ];
    const radius = Math.max(Math.hypot(sx, sy, sz) * 0.5, 4.0);
    const fovY = (32.0 * Math.PI) / 180.0;
    const aspect = tw / th;
    const dist = ((radius / Math.tan(fovY * 0.5)) * 1.12) / 1.05;
    const yaw = (-35.0 * Math.PI) / 180.0;
    const pitch = (48.0 * Math.PI) / 180.0;
    const eye: [number, number, number] = [
      center[0] + dist * Math.cos(pitch) * Math.sin(yaw),
      center[1] - dist * Math.cos(pitch) * Math.cos(yaw),
      center[2] + dist * Math.sin(pitch),
    ];
    const proj = perspectiveRhZeroToOne(
      fovY,
      aspect,
      Math.max(dist * 0.05, 0.2),
      dist * 4.0
    );
    const view = lookAtRh(eye, center, [0, 0, 1]);
    const vp = mulMat4(proj, view);

    const packed = new Uint8Array(this.uniformStride * 5);
    for (let s = 0; s < 5; s++) {
      const slot = new Float32Array(
        packed.buffer,
        s * this.uniformStride,
        RENDER_UNIFORM_BYTES / 4
      );
      slot.set(vp, 0);
      slot.set([eye[0], eye[1], eye[2], 1.0], 16);
      slot.set(
        [stock.min[0], stock.min[1], stock.min[2], darkMode ? 0.0 : 1.0],
        20
      );
      slot.set([stock.max[0], stock.max[1], stock.max[2], 0.0], 24);
      slot.set([gw, gh, cellDx, cellDy], 28);
      slot.set([materialId, s, 1.0, 0.0], 32);
      slot.set([center[0], center[1], stock.max[2] + 10, 1.5], 36);
      slot.set([0, 0.2, 0.1, 15], 40);
      slot.set([0, 0, 0, 1], 44);
      slot.set([0, 0, 0, 0], 48);
    }
    this.device.queue.writeBuffer(this.thumbPartUniformBuf, 0, packed);

    const partBg = this.device.createBindGroup({
      layout: this.partBgl,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.thumbPartUniformBuf,
            offset: 0,
            size: RENDER_UNIFORM_BYTES,
          },
        },
        { binding: 1, resource: { buffer: tHeightBuf } },
      ],
    });

    const clearBg = darkMode
      ? { r: 0.068, g: 0.071, b: 0.084, a: 1.0 }
      : { r: 0.945, g: 0.949, b: 0.961, a: 1.0 };

    const rpass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.thumbMsaaView,
          resolveTarget: this.thumbCtx.getCurrentTexture().createView(),
          clearValue: clearBg,
          loadOp: "clear",
          storeOp: "discard",
        },
      ],
      depthStencilAttachment: {
        view: this.thumbDepthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });

    const topVerts = (gw - 1) * (gh - 1) * 6;
    const skirtVerts = 2 * (gw - 1 + (gh - 1)) * 6;
    rpass.setPipeline(this.partPipeline);
    rpass.setBindGroup(0, partBg, [4 * this.uniformStride]);
    rpass.draw(6);
    rpass.setBindGroup(0, partBg, [0]);
    rpass.draw(topVerts);
    rpass.setBindGroup(0, partBg, [this.uniformStride]);
    rpass.draw(skirtVerts);
    rpass.setBindGroup(0, partBg, [2 * this.uniformStride]);
    rpass.draw(topVerts);
    rpass.end();

    this.device.queue.submit([enc.finish()]);
    const dataUrl = this.thumbCanvas.toDataURL("image/webp", 0.9);
    tSegBuf.destroy();
    tHeightBuf.destroy();
    return dataUrl;
  }

  projectWorldToCss(pt: [number, number, number]): { x: number; y: number; visible: boolean } {
    const cw = Math.max(this.canvas.clientWidth, 1);
    const ch = Math.max(this.canvas.clientHeight, 1);
    return projectPointToCss(this.lastViewProj, pt, cw, ch);
  }

  private sampleRawZ(wx: number, wy: number): number {
    if (this.cpuHeights.length !== this.gridW * this.gridH || this.gridW < 2) {
      return this.lastStock.max[2];
    }
    const fx = Math.min(
      Math.max((wx - this.lastStock.min[0]) / this.cellDx, 0),
      this.gridW - 1.0001
    );
    const fy = Math.min(
      Math.max((wy - this.lastStock.min[1]) / this.cellDy, 0),
      this.gridH - 1.0001
    );
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;

    const gw = this.gridW;
    const z00 = this.cpuHeights[iy * gw + ix] / 10000.0;
    const z10 = this.cpuHeights[iy * gw + ix + 1] / 10000.0;
    const z01 = this.cpuHeights[(iy + 1) * gw + ix] / 10000.0;
    const z11 = this.cpuHeights[(iy + 1) * gw + ix + 1] / 10000.0;

    const za = z00 + (z10 - z00) * tx;
    const zb = z01 + (z11 - z01) * tx;
    return za + (zb - za) * ty;
  }

  /**
   * Sub-millimeter ray-picking against the 3D machined workpiece (respecting active X/Y cross-section plane!).
   */
  pickModelPoint(
    localCssX: number,
    localCssY: number,
    showSolid: boolean,
    activeSegments: number
  ): [number, number, number] | null {
    const cw = Math.max(this.canvas.clientWidth, 1);
    const ch = Math.max(this.canvas.clientHeight, 1);

    // Locate the active sub-viewport containing (localCssX, localCssY)
    let viewEntry = this.lastRenderedViews.find(
      (v) =>
        localCssX >= v.cssX &&
        localCssX <= v.cssX + v.cssW &&
        localCssY >= v.cssY &&
        localCssY <= v.cssY + v.cssH
    );
    if (!viewEntry && this.lastInvViewProj) {
      viewEntry = {
        cssX: 0,
        cssY: 0,
        cssW: cw,
        cssH: ch,
        viewProj: this.lastViewProj,
        invViewProj: this.lastInvViewProj,
      };
    }
    if (!viewEntry || !viewEntry.invViewProj) return null;

    const subLocalX = localCssX - viewEntry.cssX;
    const subLocalY = localCssY - viewEntry.cssY;
    const subW = Math.max(viewEntry.cssW, 1);
    const subH = Math.max(viewEntry.cssH, 1);
    const ndcX = (subLocalX / subW) * 2.0 - 1.0;
    const ndcY = 1.0 - (subLocalY / subH) * 2.0;

    if (showSolid && this.cpuHeights.length === this.gridW * this.gridH && this.gridW >= 2) {
      const pNear = unprojectPoint(viewEntry.invViewProj, ndcX, ndcY, 0.0);
      const pFar = unprojectPoint(viewEntry.invViewProj, ndcX, ndcY, 1.0);
      let dx = pFar[0] - pNear[0];
      let dy = pFar[1] - pNear[1];
      let dz = pFar[2] - pNear[2];
      const len = Math.hypot(dx, dy, dz) || 1.0;
      dx /= len;
      dy /= len;
      dz /= len;

      const smin: [number, number, number] = [
        this.lastSectionAxis === 1
          ? Math.max(this.lastStock.min[0], this.lastSectionPos)
          : this.lastStock.min[0],
        this.lastSectionAxis === 2
          ? Math.max(this.lastStock.min[1], this.lastSectionPos)
          : this.lastStock.min[1],
        this.lastStock.min[2],
      ];
      const smax = this.lastStock.max;

      // Ray-AABB slab intersection against clipped [smin .. smax]
      let tMin = 0.0;
      let tMax = len;
      const orig = pNear;
      const dir = [dx, dy, dz];

      for (let a = 0; a < 3; a++) {
        if (Math.abs(dir[a]) < 1e-8) {
          if (orig[a] < smin[a] || orig[a] > smax[a]) {
            return null;
          }
        } else {
          const invD = 1.0 / dir[a];
          let t1 = (smin[a] - orig[a]) * invD;
          let t2 = (smax[a] - orig[a]) * invD;
          if (t1 > t2) {
            const tmp = t1;
            t1 = t2;
            t2 = tmp;
          }
          tMin = Math.max(tMin, t1);
          tMax = Math.min(tMax, t2);
          if (tMin > tMax) {
            return null;
          }
        }
      }

      // 1. Check immediate hit on outer vertical stock skirt OR the hatched 3D cross-section cut wall!
      const ex = orig[0] + tMin * dx;
      const ey = orig[1] + tMin * dy;
      const ez = orig[2] + tMin * dz;
      const wallEps = Math.max(this.cellDx, this.cellDy) * 0.75;
      const onVerticalWall =
        Math.abs(ex - smin[0]) <= wallEps ||
        Math.abs(ex - smax[0]) <= wallEps ||
        Math.abs(ey - smin[1]) <= wallEps ||
        Math.abs(ey - smax[1]) <= wallEps;

      if (onVerticalWall) {
        const edgeRawZ = this.sampleRawZ(ex, ey);
        const edgeSurfZ = Math.min(Math.max(edgeRawZ, smin[2]), smax[2]);
        if (ez <= edgeSurfZ + 1e-3 && ez >= smin[2] - 1e-3 && edgeRawZ >= smin[2] - 0.03) {
          return [
            Math.min(Math.max(ex, smin[0]), smax[0]),
            Math.min(Math.max(ey, smin[1]), smax[1]),
            Math.min(Math.max(ez, smin[2]), edgeSurfZ),
          ];
        }
      }

      // 2. Fine ray-march across the machined heightfield + 8-step binary refinement
      const step = Math.max(Math.min(this.cellDx, this.cellDy) * 0.45, 0.05);
      let prevT = tMin;
      for (let t = tMin; t <= tMax + step * 0.5; t += step) {
        const tc = Math.min(t, tMax);
        const px = orig[0] + tc * dx;
        const py = orig[1] + tc * dy;
        const pz = orig[2] + tc * dz;
        const rawZ = this.sampleRawZ(px, py);
        // Skip pierced through-holes
        if (rawZ >= smin[2] - 0.03) {
          const surfZ = Math.min(Math.max(rawZ, smin[2]), smax[2]);
          if (pz <= surfZ) {
            let lo = prevT;
            let hi = tc;
            for (let it = 0; it < 8; it++) {
              const mid = 0.5 * (lo + hi);
              const mx = orig[0] + mid * dx;
              const my = orig[1] + mid * dy;
              const mz = orig[2] + mid * dz;
              const mSurf = Math.min(Math.max(this.sampleRawZ(mx, my), smin[2]), smax[2]);
              if (mz <= mSurf) {
                hi = mid;
              } else {
                lo = mid;
              }
            }
            const hitT = 0.5 * (lo + hi);
            const hx = Math.min(Math.max(orig[0] + hitT * dx, smin[0]), smax[0]);
            const hy = Math.min(Math.max(orig[1] + hitT * dy, smin[1]), smax[1]);
            const hz = Math.min(Math.max(this.sampleRawZ(hx, hy), smin[2]), smax[2]);
            return [hx, hy, hz];
          }
        }
        prevT = tc;
        if (tc >= tMax) break;
      }
      return null;
    }

    // Toolpath-only mode: snap to nearest visible toolpath point within 16px
    const limit = Math.min(Math.max(activeSegments, 0), this.totalSegments);
    let bestDist2 = 16 * 16;
    let bestPt: [number, number, number] | null = null;
    const stride = Math.max(Math.floor(limit / 12000), 1);
    for (let i = 0; i < limit; i += stride) {
      const base = i * 8;
      const cand: [number, number, number] = [
        this.segFloats[base + 4],
        this.segFloats[base + 5],
        this.segFloats[base + 6],
      ];
      const sp = projectPointToCss(viewEntry.viewProj, cand, subW, subH);
      if (sp.visible) {
        const d2 = (sp.x - subLocalX) ** 2 + (sp.y - subLocalY) ** 2;
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestPt = cand;
        }
      }
    }
    return bestPt;
  }

  render(p: ViewportRenderParams) {
    const cssW = Math.max(this.canvas.clientWidth, 64);
    const cssH = Math.max(this.canvas.clientHeight, 64);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(Math.floor(cssW * dpr), 64);
    const h = Math.max(Math.floor(cssH * dpr), 64);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ensureAttachments(w, h);

    const encoder = this.device.createCommandEncoder();
    if (p.showSolid || !this.heightBuffer) {
      this.updateSimulationIfNeeded(encoder, p);
    }
    this.updateRoiSchedule(p);

    const sx = p.stock.max[0] - p.stock.min[0];
    const sy = p.stock.max[1] - p.stock.min[1];
    const sz = p.stock.max[2] - p.stock.min[2];
    const stockCenter: [number, number, number] = [
      0.5 * (p.stock.min[0] + p.stock.max[0]),
      0.5 * (p.stock.min[1] + p.stock.max[1]),
      0.5 * (p.stock.min[2] + p.stock.max[2]),
    ];
    const diag = Math.hypot(sx, sy, sz);
    const radius = Math.max(diag * 0.5, 5.0);
    const fovY = (33.0 * Math.PI) / 180.0;

    const secAxis: 0 | 1 | 2 = p.sectionAxis ?? 0;
    const secRatio = Math.min(Math.max(p.sectionRatio ?? 0.5, 0.0), 1.0);
    const secPos =
      secAxis === 1
        ? p.stock.min[0] + secRatio * sx
        : secAxis === 2
        ? p.stock.min[1] + secRatio * sy
        : 0.0;
    this.lastStock = p.stock;
    this.lastSectionAxis = secAxis;
    this.lastSectionPos = secPos;

    const tip = this.getSegmentTip(p.activeSegments);
    const cutterX = p.cutterOverride
      ? p.cutterOverride[0]
      : tip
      ? tip.x
      : stockCenter[0];
    const cutterY = p.cutterOverride
      ? p.cutterOverride[1]
      : tip
      ? tip.y
      : stockCenter[1];
    const cutterZ = p.cutterOverride
      ? p.cutterOverride[2]
      : tip
      ? tip.z
      : p.stock.max[2] + 5.0;
    this.lastCutterWorldPos = [cutterX, cutterY, cutterZ];

    const activeRoi =
      p.showSolid && this.roiState && this.roiHeightBuffer ? this.roiState : null;
    const wcs = p.wcsOrigin ?? [stockCenter[0], stockCenter[1], p.stock.max[2]];

    const views: SubViewportSpec[] =
      p.subViewports && p.subViewports.length > 0
        ? p.subViewports.slice(0, MAX_SUB_VIEWS)
        : [{ rect: [0, 0, 1, 1], camera: p.camera }];

    const viewCount = views.length;
    const packed = new Uint8Array(
      this.uniformStride * PART_SLOTS_PER_VIEW * viewCount
    );
    const linePacked = new Uint8Array(
      this.uniformStride * LINE_SLOTS_PER_VIEW * viewCount
    );

    const vpPixelRects: Array<[number, number, number, number]> = [];
    this.lastRenderedViews = [];

    for (let vIdx = 0; vIdx < viewCount; vIdx++) {
      const sv = views[vIdx];
      const [rx, ry, rw, rh] = sv.rect;
      const px0 = Math.min(Math.max(Math.round(rx * w), 0), w - 1);
      const py0 = Math.min(Math.max(Math.round(ry * h), 0), h - 1);
      const px1 = Math.min(Math.max(Math.round((rx + rw) * w), px0 + 1), w);
      const py1 = Math.min(Math.max(Math.round((ry + rh) * h), py0 + 1), h);
      const vpW = Math.max(px1 - px0, 1);
      const vpH = Math.max(py1 - py0, 1);
      vpPixelRects.push([px0, py0, vpW, vpH]);

      const cam = sv.camera;
      const center: [number, number, number] = [
        stockCenter[0] + cam.panX,
        stockCenter[1] + cam.panY,
        stockCenter[2] + cam.panZ,
      ];
      const aspect = vpW / vpH;
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
        : perspectiveRhZeroToOne(
            fovY,
            aspect,
            Math.max(dist * 0.02, 0.2),
            dist * 5.0
          );
      const viewMat = lookAtRh(eye, center, [0, 0, 1]);
      const viewProj = mulMat4(proj, viewMat);
      const invViewProj = invertMat4(viewProj);

      if (vIdx === 0) {
        this.lastViewProj = viewProj;
        this.lastInvViewProj = invViewProj;
      }
      this.lastRenderedViews.push({
        cssX: rx * cssW,
        cssY: ry * cssH,
        cssW: rw * cssW,
        cssH: rh * cssH,
        viewProj,
        invViewProj,
      });

      // Pack 7 part uniform slots for sub-viewport vIdx
      for (let slotIdx = 0; slotIdx < PART_SLOTS_PER_VIEW; slotIdx++) {
        const globalSlot = vIdx * PART_SLOTS_PER_VIEW + slotIdx;
        const slot = new Float32Array(
          packed.buffer,
          globalSlot * this.uniformStride,
          RENDER_UNIFORM_BYTES / 4
        );
        const isRoiSlot = slotIdx === 6;
        const passKind = isRoiSlot ? 0 : slotIdx;

        slot.set(viewProj, 0);
        slot.set([eye[0], eye[1], eye[2], 1.0], 16);

        if (isRoiSlot && activeRoi) {
          slot.set(
            [
              activeRoi.minX,
              activeRoi.minY,
              p.stock.min[2],
              p.darkMode ? 0.0 : 1.0,
            ],
            20
          );
          slot.set([p.stock.max[0], p.stock.max[1], p.stock.max[2], 0.0], 24);
          slot.set(
            [activeRoi.roiW, activeRoi.roiH, activeRoi.cellDx, activeRoi.cellDy],
            28
          );
        } else {
          slot.set(
            [
              p.stock.min[0],
              p.stock.min[1],
              p.stock.min[2],
              p.darkMode ? 0.0 : 1.0,
            ],
            20
          );
          slot.set([p.stock.max[0], p.stock.max[1], p.stock.max[2], 0.0], 24);
          slot.set([this.gridW, this.gridH, this.cellDx, this.cellDy], 28);
        }

        slot.set([p.materialId, passKind, 1.0, 0.0], 32);
        slot.set(
          [cutterX, cutterY, cutterZ, Math.max(p.tool.diameter * 0.5, 0.2)],
          36
        );
        slot.set(
          [
            TOOL_KIND_CODE[p.tool.kind] ?? 0,
            p.tool.tip_radius,
            (p.tool.half_angle_deg * Math.PI) / 180.0,
            p.tool.flute_length,
          ],
          40
        );

        const roiMode = slotIdx === 0 && activeRoi ? 1.0 : 0.0;
        const aoStepMul = isRoiSlot && activeRoi ? activeRoi.subdiv : 1.0;
        slot.set([secAxis, secPos, roiMode, aoStepMul], 44);

        if (activeRoi) {
          slot.set(
            [activeRoi.ix0, activeRoi.iy0, activeRoi.ix1, activeRoi.iy1],
            48
          );
        } else {
          slot.set([0, 0, 0, 0], 48);
        }
      }

      // Pack 3 line uniform slots for sub-viewport vIdx
      for (let lSlot = 0; lSlot < LINE_SLOTS_PER_VIEW; lSlot++) {
        const globalLineSlot = vIdx * LINE_SLOTS_PER_VIEW + lSlot;
        const lf = new Float32Array(
          linePacked.buffer,
          globalLineSlot * this.uniformStride,
          32
        );
        lf.set(viewProj, 0);
        lf.set(
          [
            p.showRapidsOverlay ? 1.0 : 0.0,
            p.showCutsOverlay ? 1.0 : 0.0,
            p.darkMode ? 0.0 : 1.0,
            lSlot,
          ],
          16
        );
        lf.set([p.stock.min[0], p.stock.min[1], p.stock.min[2], 0.0], 20);
        lf.set([p.stock.max[0], p.stock.max[1], p.stock.max[2], 0.0], 24);
        lf.set([wcs[0], wcs[1], wcs[2], 0.0], 28);
      }
    }

    this.device.queue.writeBuffer(this.partUniformBuf, 0, packed);
    this.device.queue.writeBuffer(this.lineUniformBuf, 0, linePacked);

    const partBg = this.device.createBindGroup({
      layout: this.partBgl,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.partUniformBuf,
            offset: 0,
            size: RENDER_UNIFORM_BYTES,
          },
        },
        { binding: 1, resource: { buffer: this.heightBuffer! } },
      ],
    });

    const roiPartBg =
      activeRoi && this.roiHeightBuffer
        ? this.device.createBindGroup({
            layout: this.partBgl,
            entries: [
              {
                binding: 0,
                resource: {
                  buffer: this.partUniformBuf,
                  offset: 0,
                  size: RENDER_UNIFORM_BYTES,
                },
              },
              { binding: 1, resource: { buffer: this.roiHeightBuffer } },
            ],
          })
        : null;

    const lineBg = this.device.createBindGroup({
      layout: this.lineBgl,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.lineUniformBuf, offset: 0, size: 128 },
        },
        { binding: 1, resource: { buffer: this.segBuffer! } },
      ],
    });

    const clearBg = p.darkMode
      ? { r: 0.036, g: 0.036, b: 0.044, a: 1.0 }
      : { r: 0.958, g: 0.961, b: 0.969, a: 1.0 };

    const swapView = this.ctx.getCurrentTexture().createView();
    const rpass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.msaaView!,
          resolveTarget: swapView,
          clearValue: clearBg,
          loadOp: "clear",
          storeOp: "discard",
        },
      ],
      depthStencilAttachment: {
        view: this.depthView!,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });

    const topVerts = (this.gridW - 1) * (this.gridH - 1) * 6;
    const skirtVerts = 2 * (this.gridW - 1 + (this.gridH - 1)) * 6;
    const activeDraw = Math.min(
      Math.max(p.activeSegments, 0),
      this.totalSegments
    );

    for (let vIdx = 0; vIdx < viewCount; vIdx++) {
      const [px0, py0, vpW, vpH] = vpPixelRects[vIdx];
      rpass.setViewport(px0, py0, vpW, vpH, 0.0, 1.0);
      rpass.setScissorRect(px0, py0, vpW, vpH);

      const pBase = vIdx * PART_SLOTS_PER_VIEW;
      const lBase = vIdx * LINE_SLOTS_PER_VIEW;

      rpass.setPipeline(this.partPipeline);

      if (p.showFloor) {
        rpass.setBindGroup(0, partBg, [(pBase + 4) * this.uniformStride]);
        rpass.draw(6);
      }

      if (p.showSolid) {
        // Pass 0: Machined Top Surface
        rpass.setBindGroup(0, partBg, [(pBase + 0) * this.uniformStride]);
        rpass.draw(topVerts);

        // Slot 6: Seamless Ultra-HD ROI Microscope Patch
        if (activeRoi && roiPartBg) {
          const roiVerts = (activeRoi.roiW - 1) * (activeRoi.roiH - 1) * 6;
          rpass.setBindGroup(0, roiPartBg, [(pBase + 6) * this.uniformStride]);
          rpass.draw(roiVerts);
        }

        // Pass 1: Outer Watertight Skirt
        rpass.setBindGroup(0, partBg, [(pBase + 1) * this.uniformStride]);
        rpass.draw(skirtVerts);

        // Pass 2: Pierced Bottom Cap
        rpass.setBindGroup(0, partBg, [(pBase + 2) * this.uniformStride]);
        rpass.draw(topVerts);

        // Pass 5: Hatched Solid Cross-Section Cut Wall
        if (secAxis > 0 && secRatio > 0.002 && secRatio < 0.998) {
          const secSegs = secAxis === 1 ? this.gridH - 1 : this.gridW - 1;
          rpass.setBindGroup(0, partBg, [(pBase + 5) * this.uniformStride]);
          rpass.draw(secSegs * 6);
        }
      }

      // Pass 3: 3D Revolved Cutter + Collet
      if (p.showCutter && this.totalSegments > 0 && p.activeSegments > 0) {
        rpass.setBindGroup(0, partBg, [(pBase + 3) * this.uniformStride]);
        rpass.draw(32 * 24 * 6);
      }

      // WCS Origin Triad + Stock Box Wireframe + Toolpath Lines
      rpass.setPipeline(this.linePipeline);
      if (p.showFloor) {
        rpass.setBindGroup(0, lineBg, [(lBase + 2) * this.uniformStride]);
        rpass.draw(6);
      }
      if (p.showStockBox) {
        rpass.setBindGroup(0, lineBg, [(lBase + 1) * this.uniformStride]);
        rpass.draw(24);
      }
      if ((p.showCutsOverlay || p.showRapidsOverlay) && activeDraw > 0) {
        rpass.setBindGroup(0, lineBg, [(lBase + 0) * this.uniformStride]);
        rpass.draw(activeDraw * 2);
      }
    }

    rpass.end();
    this.device.queue.submit([encoder.finish()]);
    this.scheduleHeightReadbackIfNeeded();
  }

  destroy() {
    if (this.roiTimer !== null) {
      window.clearTimeout(this.roiTimer);
    }
    this.segBuffer?.destroy();
    this.heightBuffer?.destroy();
    this.roiHeightBuffer?.destroy();
    this.partUniformBuf?.destroy();
    this.lineUniformBuf?.destroy();
    this.msaaTex?.destroy();
    this.depthTex?.destroy();
    this.thumbMsaaTex?.destroy();
    this.thumbDepthTex?.destroy();
    this.thumbPartUniformBuf?.destroy();
    this.device?.destroy();
  }
}
