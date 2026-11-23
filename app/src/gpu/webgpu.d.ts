/// <reference types="vite/client" />
// Minimal WebGPU ambient declarations so TypeScript builds cleanly without external type packages.

declare global {
  interface Navigator {
    readonly gpu?: GPU;
  }

  interface GPU {
    requestAdapter(options?: Record<string, unknown>): Promise<GPUAdapter | null>;
    getPreferredCanvasFormat(): GPUTextureFormat;
  }

  type GPUTextureFormat = string;

  interface GPUAdapter {
    readonly limits: Record<string, number>;
    requestDevice(descriptor?: Record<string, unknown>): Promise<GPUDevice>;
  }

  interface GPUDevice {
    readonly limits: Record<string, number>;
    readonly queue: GPUQueue;
    createShaderModule(descriptor: { label?: string; code: string }): GPUShaderModule;
    createBuffer(descriptor: {
      label?: string;
      size: number;
      usage: number;
      mappedAtCreation?: boolean;
    }): GPUBuffer;
    createTexture(descriptor: Record<string, unknown>): GPUTexture;
    createBindGroupLayout(descriptor: Record<string, unknown>): GPUBindGroupLayout;
    createPipelineLayout(descriptor: Record<string, unknown>): GPUPipelineLayout;
    createComputePipeline(descriptor: Record<string, unknown>): GPUComputePipeline;
    createRenderPipeline(descriptor: Record<string, unknown>): GPURenderPipeline;
    createBindGroup(descriptor: Record<string, unknown>): GPUBindGroup;
    createCommandEncoder(descriptor?: Record<string, unknown>): GPUCommandEncoder;
    destroy(): void;
  }

  interface GPUQueue {
    writeBuffer(
      buffer: GPUBuffer,
      bufferOffset: number,
      data: BufferSource | SharedArrayBuffer,
      dataOffset?: number,
      size?: number
    ): void;
    submit(commandBuffers: Iterable<GPUCommandBuffer>): void;
  }

  interface GPUCanvasContext {
    configure(configuration: {
      device: GPUDevice;
      format: GPUTextureFormat;
      alphaMode?: "opaque" | "premultiplied";
    }): void;
    getCurrentTexture(): GPUTexture;
  }

  interface GPUBuffer {
    destroy(): void;
    readonly size: number;
    mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
    getMappedRange(offset?: number, size?: number): ArrayBuffer;
    unmap(): void;
  }

  interface GPUTexture {
    createView(descriptor?: Record<string, unknown>): GPUTextureView;
    destroy(): void;
  }

  interface GPUTextureView {}
  interface GPUShaderModule {}
  interface GPUBindGroupLayout {}
  interface GPUPipelineLayout {}
  interface GPUComputePipeline {}
  interface GPURenderPipeline {}
  interface GPUBindGroup {}
  interface GPUCommandBuffer {}

  interface GPUCommandEncoder {
    beginComputePass(descriptor?: Record<string, unknown>): GPUComputePassEncoder;
    beginRenderPass(descriptor: Record<string, unknown>): GPURenderPassEncoder;
    copyBufferToBuffer(
      source: GPUBuffer,
      sourceOffset: number,
      destination: GPUBuffer,
      destinationOffset: number,
      size: number
    ): void;
    finish(): GPUCommandBuffer;
  }

  interface GPUComputePassEncoder {
    setPipeline(pipeline: GPUComputePipeline): void;
    setBindGroup(index: number, bindGroup: GPUBindGroup, dynamicOffsets?: Iterable<number>): void;
    dispatchWorkgroups(x: number, y?: number, z?: number): void;
    end(): void;
  }

  interface GPURenderPassEncoder {
    setPipeline(pipeline: GPURenderPipeline): void;
    setBindGroup(index: number, bindGroup: GPUBindGroup, dynamicOffsets?: Iterable<number>): void;
    setViewport(
      x: number,
      y: number,
      width: number,
      height: number,
      minDepth: number,
      maxDepth: number
    ): void;
    setScissorRect(x: number, y: number, width: number, height: number): void;
    draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
    end(): void;
  }

  const GPUBufferUsage: {
    readonly MAP_READ: number;
    readonly MAP_WRITE: number;
    readonly COPY_SRC: number;
    readonly COPY_DST: number;
    readonly INDEX: number;
    readonly VERTEX: number;
    readonly UNIFORM: number;
    readonly STORAGE: number;
    readonly INDIRECT: number;
    readonly QUERY_RESOLVE: number;
  };

  const GPUTextureUsage: {
    readonly COPY_SRC: number;
    readonly COPY_DST: number;
    readonly TEXTURE_BINDING: number;
    readonly STORAGE_BINDING: number;
    readonly RENDER_ATTACHMENT: number;
  };

  const GPUShaderStage: {
    readonly VERTEX: number;
    readonly FRAGMENT: number;
    readonly COMPUTE: number;
  };

  const GPUMapMode: {
    readonly READ: number;
    readonly WRITE: number;
  };
}

declare module "*.wgsl?raw" {
  const src: string;
  export default src;
}

export {};
