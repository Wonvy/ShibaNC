use std::sync::OnceLock;

use glam::{Mat4, Vec3};
use shibanc_gcode::{GpuSegment, ParsedProgram};
use thiserror::Error;
use wgpu::util::DeviceExt;

use crate::types::{
    LineUniformsGpu, MaterialPreset, RenderOptions, RenderUniformsGpu, SimParamsGpu,
};

pub const SIM_SHADER_WGSL: &str = include_str!("../../../shaders/sim_3axis.wgsl");
pub const STUDIO_PART_WGSL: &str = include_str!("../../../shaders/studio_part.wgsl");
pub const TOOLPATH_WGSL: &str = include_str!("../../../shaders/toolpath.wgsl");

const MSAA_SAMPLES: u32 = 4;

#[derive(Debug, Error)]
pub enum RenderError {
    #[error("无法初始化 GPU 适配器")]
    NoAdapter,
    #[error("GPU 设备请求失败: {0}")]
    Device(#[from] wgpu::RequestDeviceError),
    #[error("读取离屏渲染缓冲失败")]
    ReadbackFailed,
}

/// Reusable thread-safe headless GPU Compute + 4x MSAA Studio Renderer.
/// Cached via `OnceLock` so OS Explorer thumbnail bursts execute in ~10-25ms per file!
pub struct HeadlessGpuEngine {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    sim_bgl: wgpu::BindGroupLayout,
    init_pipeline: wgpu::ComputePipeline,
    carve_pipeline: wgpu::ComputePipeline,
    part_bgl: wgpu::BindGroupLayout,
    part_pipeline: wgpu::RenderPipeline,
    line_bgl: wgpu::BindGroupLayout,
    line_pipeline: wgpu::RenderPipeline,
}

static GLOBAL_GPU: OnceLock<Option<HeadlessGpuEngine>> = OnceLock::new();

pub fn global_gpu_engine() -> Option<&'static HeadlessGpuEngine> {
    GLOBAL_GPU
        .get_or_init(|| HeadlessGpuEngine::new().ok())
        .as_ref()
}

impl HeadlessGpuEngine {
    pub fn new() -> Result<Self, RenderError> {
        pollster::block_on(Self::new_async())
    }

    async fn new_async() -> Result<Self, RenderError> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::all(),
            ..Default::default()
        });

        let adapter = match instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
        {
            Some(a) => a,
            None => instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::LowPower,
                    compatible_surface: None,
                    force_fallback_adapter: true,
                })
                .await
                .ok_or(RenderError::NoAdapter)?,
        };

        let mut limits = wgpu::Limits::default();
        limits.max_storage_buffer_binding_size = adapter
            .limits()
            .max_storage_buffer_binding_size
            .min(512 * 1024 * 1024);
        limits.max_buffer_size = adapter.limits().max_buffer_size.min(512 * 1024 * 1024);

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("ShibaNC Headless GPU"),
                    required_features: wgpu::Features::empty(),
                    required_limits: limits,
                    memory_hints: wgpu::MemoryHints::Performance,
                },
                None,
            )
            .await?;

        let sim_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("sim_3axis.wgsl"),
            source: wgpu::ShaderSource::Wgsl(SIM_SHADER_WGSL.into()),
        });
        let part_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("studio_part.wgsl"),
            source: wgpu::ShaderSource::Wgsl(STUDIO_PART_WGSL.into()),
        });
        let line_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("toolpath.wgsl"),
            source: wgpu::ShaderSource::Wgsl(TOOLPATH_WGSL.into()),
        });

        // 1. Compute simulation bind group layout
        let sim_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("sim_bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let sim_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("sim_pl"),
            bind_group_layouts: &[&sim_bgl],
            push_constant_ranges: &[],
        });

        let init_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("init_stock_grid"),
            layout: Some(&sim_pl),
            module: &sim_module,
            entry_point: Some("init_stock_grid"),
            compilation_options: Default::default(),
            cache: None,
        });

        let carve_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("carve_segments"),
            layout: Some(&sim_pl),
            module: &sim_module,
            entry_point: Some("carve_segments"),
            compilation_options: Default::default(),
            cache: None,
        });

        // 2. Studio Part render pipeline (RGBA8Unorm + 4x MSAA + Depth32Float)
        let part_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("part_bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: true,
                        min_binding_size: wgpu::BufferSize::new(
                            std::mem::size_of::<RenderUniformsGpu>() as u64,
                        ),
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let part_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("part_pl"),
            bind_group_layouts: &[&part_bgl],
            push_constant_ranges: &[],
        });

        let part_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("part_pipeline"),
            layout: Some(&part_pl),
            vertex: wgpu::VertexState {
                module: &part_module,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &part_module,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None, // Two-sided walls & through-hole interiors visible cleanly
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth32Float,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::LessEqual,
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: wgpu::MultisampleState {
                count: MSAA_SAMPLES,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
            multiview: None,
            cache: None,
        });

        // 3. Toolpath Wireframe Overlay pipeline
        let line_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("line_bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let line_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("line_pl"),
            bind_group_layouts: &[&line_bgl],
            push_constant_ranges: &[],
        });

        let line_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("line_pipeline"),
            layout: Some(&line_pl),
            vertex: wgpu::VertexState {
                module: &line_module,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &line_module,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::LineList,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth32Float,
                depth_write_enabled: false,
                depth_compare: wgpu::CompareFunction::LessEqual,
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: wgpu::MultisampleState {
                count: MSAA_SAMPLES,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
            multiview: None,
            cache: None,
        });

        Ok(Self {
            device,
            queue,
            sim_bgl,
            init_pipeline,
            carve_pipeline,
            part_bgl,
            part_pipeline,
            line_bgl,
            line_pipeline,
        })
    }

    /// Run full 3-axis GPU Compute simulation + 4x MSAA Studio render into an RGBA8 buffer.
    pub fn render_program(
        &self,
        program: &ParsedProgram,
        opts: &RenderOptions,
        file_ext: &str,
    ) -> Result<Vec<u8>, RenderError> {
        let width = opts.width.clamp(64, 4096);
        let height = opts.height.clamp(64, 4096);
        let stock = &program.stock;
        let tool = &program.tool;
        let size = stock.size();

        let max_dim = opts.grid_max_dim.clamp(128, 2048) as f32;
        let scale = max_dim / size[0].max(size[1]).max(1.0);
        let grid_w = ((size[0] * scale).round() as u32).clamp(64, 2048);
        let grid_h = ((size[1] * scale).round() as u32).clamp(64, 2048);
        let cell_dx = size[0] / ((grid_w - 1) as f32);
        let cell_dy = size[1] / ((grid_h - 1) as f32);

        let dummy_seg = [GpuSegment::default()];
        let active_count = opts
            .active_segments
            .unwrap_or(program.segments.len())
            .min(program.segments.len());
        let seg_slice: &[GpuSegment] = if program.segments.is_empty() {
            &dummy_seg
        } else {
            &program.segments[..active_count.max(1)]
        };

        let seg_buf = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("segments_buf"),
                contents: bytemuck::cast_slice(seg_slice),
                usage: wgpu::BufferUsages::STORAGE,
            });

        let height_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("heights_buf"),
            size: (grid_w as u64) * (grid_h as u64) * 4,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });

        // Dispatch simulation chunks (<= 65535 * 64 = 4,194,240 segments per chunk)
        let chunk_max: u32 = 65535 * 64;
        let total_active = if program.segments.is_empty() {
            0u32
        } else {
            active_count as u32
        };
        let num_chunks = total_active.div_ceil(chunk_max).max(1);

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("shibanc_encoder"),
            });

        for chunk_idx in 0..num_chunks {
            let seg_offset = chunk_idx * chunk_max;
            let sim_params = SimParamsGpu {
                stock_min_x: stock.min[0],
                stock_min_y: stock.min[1],
                stock_min_z: stock.min[2],
                stock_max_z: stock.max[2],
                stock_max_x: stock.max[0],
                stock_max_y: stock.max[1],
                cell_dx,
                cell_dy,
                grid_w,
                grid_h,
                active_seg_count: total_active,
                seg_offset,
                tool_kind: tool.kind.code(),
                tool_outer_r: (tool.diameter * 0.5).max(0.05),
                tool_tip_r: tool.tip_radius,
                tool_half_angle_rad: tool.half_angle_deg.to_radians(),
            };

            let sim_ubuf = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("sim_params"),
                    contents: bytemuck::bytes_of(&sim_params),
                    usage: wgpu::BufferUsages::UNIFORM,
                });

            let sim_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("sim_bg"),
                layout: &self.sim_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: sim_ubuf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: seg_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: height_buf.as_entire_binding(),
                    },
                ],
            });

            let mut cpass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("sim_pass"),
                timestamp_writes: None,
            });
            if chunk_idx == 0 {
                cpass.set_pipeline(&self.init_pipeline);
                cpass.set_bind_group(0, &sim_bg, &[]);
                cpass.dispatch_workgroups(grid_w.div_ceil(16), grid_h.div_ceil(16), 1);
            }
            if total_active > seg_offset {
                let rem = (total_active - seg_offset).min(chunk_max);
                cpass.set_pipeline(&self.carve_pipeline);
                cpass.set_bind_group(0, &sim_bg, &[]);
                cpass.dispatch_workgroups(rem.div_ceil(64), 1, 1);
            }
        }

        // Camera & Render Uniforms (5 dynamic uniform slots aligned to min_uniform_buffer_offset_alignment = 256)
        let center = Vec3::from_array(stock.center());
        let diag = (size[0] * size[0] + size[1] * size[1] + size[2] * size[2]).sqrt();
        let radius = (diag * 0.5).max(5.0);
        let yaw = opts.yaw_deg.to_radians();
        let pitch = opts.pitch_deg.to_radians();
        let fov_y = 33.0f32.to_radians();
        let aspect = (width as f32) / (height as f32);
        let fit_factor = if aspect < 1.0 { 1.0 / aspect } else { 1.0 };
        let cam_dist = (radius / (fov_y * 0.5).tan()) * 1.16 * fit_factor / opts.zoom.max(0.2);

        let eye = center
            + Vec3::new(
                cam_dist * pitch.cos() * yaw.sin(),
                -cam_dist * pitch.cos() * yaw.cos(),
                cam_dist * pitch.sin(),
            );

        let proj = Mat4::perspective_rh(fov_y, aspect, (cam_dist * 0.04).max(0.5), cam_dist * 4.0);
        let view = Mat4::look_at_rh(eye, center, Vec3::Z);
        let view_proj = (proj * view).to_cols_array_2d();

        let mat = opts
            .material
            .unwrap_or_else(|| MaterialPreset::auto_for_tool(tool.kind, file_ext));

        let last_tip = if total_active > 0 {
            let s = program.segments[(total_active - 1) as usize];
            [s.x1, s.y1, s.z1]
        } else {
            [center.x, center.y, stock.max[2] + 5.0]
        };

        let align = self
            .device
            .limits()
            .min_uniform_buffer_offset_alignment
            .max(256) as usize;
        let slot_count = 5usize; // 0=TopSurface, 1=Skirt, 2=Bottom, 3=Cutter, 4=Floor
        let mut dyn_bytes = vec![0u8; align * slot_count];

        for pass_kind in 0..slot_count {
            let ru = RenderUniformsGpu {
                view_proj,
                camera_pos: [eye.x, eye.y, eye.z, 1.0],
                stock_min: [stock.min[0], stock.min[1], stock.min[2], 0.0],
                stock_max: [stock.max[0], stock.max[1], stock.max[2], 0.0],
                grid_info: [grid_w as f32, grid_h as f32, cell_dx, cell_dy],
                style_info: [mat.id() as f32, pass_kind as f32, 1.0, 0.0],
                cutter_pos: [
                    last_tip[0],
                    last_tip[1],
                    last_tip[2],
                    (tool.diameter * 0.5).max(0.2),
                ],
                cutter_geom: [
                    tool.kind.code() as f32,
                    tool.tip_radius,
                    tool.half_angle_deg.to_radians(),
                    tool.flute_length,
                ],
                section_info: [0.0; 4],
                roi_bounds: [0.0; 4],
            };
            let start = pass_kind * align;
            dyn_bytes[start..start + std::mem::size_of::<RenderUniformsGpu>()]
                .copy_from_slice(bytemuck::bytes_of(&ru));
        }

        let part_ubuf = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("part_ubuf"),
                contents: &dyn_bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });

        let part_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("part_bg"),
            layout: &self.part_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &part_ubuf,
                        offset: 0,
                        size: wgpu::BufferSize::new(
                            std::mem::size_of::<RenderUniformsGpu>() as u64,
                        ),
                    }),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: height_buf.as_entire_binding(),
                },
            ],
        });

        let line_uniforms = LineUniformsGpu {
            view_proj,
            opts: [
                if opts.show_rapids_overlay { 1.0 } else { 0.0 },
                if opts.show_cuts_overlay { 1.0 } else { 0.0 },
                0.0,
                0.0,
            ],
            stock_min: [stock.min[0], stock.min[1], stock.min[2], 0.0],
            stock_max: [stock.max[0], stock.max[1], stock.max[2], 0.0],
            wcs_origin: [center.x, center.y, stock.max[2], 0.0],
        };
        let line_ubuf = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("line_ubuf"),
                contents: bytemuck::bytes_of(&line_uniforms),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let line_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("line_bg"),
            layout: &self.line_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: line_ubuf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: seg_buf.as_entire_binding(),
                },
            ],
        });

        // Offscreen 4x MSAA Color + Resolve Target + Depth
        let msaa_tex = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("msaa_color"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: MSAA_SAMPLES,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let resolve_tex = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("resolve_color"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let depth_tex = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("msaa_depth"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: MSAA_SAMPLES,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth32Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });

        let msaa_view = msaa_tex.create_view(&Default::default());
        let resolve_view = resolve_tex.create_view(&Default::default());
        let depth_view = depth_tex.create_view(&Default::default());

        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("studio_rpass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &msaa_view,
                    resolve_target: Some(&resolve_view),
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.068,
                            g: 0.082,
                            b: 0.112,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Discard,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Discard,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            rpass.set_pipeline(&self.part_pipeline);
            let top_verts = (grid_w - 1) * (grid_h - 1) * 6;
            let skirt_verts = 2 * ((grid_w - 1) + (grid_h - 1)) * 6;

            // Floor grid (optional)
            if opts.show_floor {
                rpass.set_bind_group(0, &part_bg, &[(4 * align) as u32]);
                rpass.draw(0..6, 0..1);
            }
            if opts.show_solid {
                // Pass 0: Top Machined Surface
                rpass.set_bind_group(0, &part_bg, &[0]);
                rpass.draw(0..top_verts, 0..1);
                // Pass 1: Outer Perimeter Skirt
                rpass.set_bind_group(0, &part_bg, &[align as u32]);
                rpass.draw(0..skirt_verts, 0..1);
                // Pass 2: Bottom Cap
                rpass.set_bind_group(0, &part_bg, &[(2 * align) as u32]);
                rpass.draw(0..top_verts, 0..1);
            }
            // Pass 3: 3D Cutter
            if opts.show_cutter {
                rpass.set_bind_group(0, &part_bg, &[(3 * align) as u32]);
                rpass.draw(0..(32 * 24 * 6), 0..1);
            }
            // Optional Toolpath Lines Overlay
            if (opts.show_cuts_overlay || opts.show_rapids_overlay) && total_active > 0 {
                rpass.set_pipeline(&self.line_pipeline);
                rpass.set_bind_group(0, &line_bg, &[]);
                rpass.draw(0..(total_active * 2), 0..1);
            }
        }

        let bytes_per_row_unpadded = width * 4;
        let padded_bpr = bytes_per_row_unpadded.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let readback_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback_buf"),
            size: (padded_bpr as u64) * (height as u64),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        encoder.copy_texture_to_buffer(
            wgpu::ImageCopyTexture {
                texture: &resolve_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::ImageCopyBuffer {
                buffer: &readback_buf,
                layout: wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bpr),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );

        self.queue.submit(std::iter::once(encoder.finish()));

        let slice = readback_buf.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |res| {
            let _ = tx.send(res);
        });
        self.device.poll(wgpu::Maintain::Wait);
        rx.recv()
            .map_err(|_| RenderError::ReadbackFailed)?
            .map_err(|_| RenderError::ReadbackFailed)?;

        let data = slice.get_mapped_range();
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for row in 0..height {
            let s = (row * padded_bpr) as usize;
            let e = s + (bytes_per_row_unpadded as usize);
            rgba.extend_from_slice(&data[s..e]);
        }
        drop(data);
        readback_buf.unmap();

        Ok(rgba)
    }
}
