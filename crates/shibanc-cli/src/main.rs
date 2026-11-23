use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use shibanc_gcode::{
    generate_mechanical_nc_sample, generate_relief_tap_sample, parse_file,
};
use shibanc_render::{export_program_binary_stl, render_file_to_png, MaterialPreset, RenderOptions};

fn print_usage() {
    eprintln!(
        "ShibaNC CLI — 跨平台三轴 G 代码刀路分析、高清离屏渲染与系统缩略图工具\n\
         \n\
         用法:\n\
           shibanc-cli thumb -i <input.tap/.nc> -o <output.png> [-s <size>] [-m <alu|wood|brass|jade|pine|heatmap>]\n\
           shibanc-cli export-stl -i <input.tap/.nc> -o <output.stl> [-g <grid_dim>]\n\
           shibanc-cli inspect <input.tap/.nc>\n\
           shibanc-cli generate-samples [-d <dir>]\n\
           shibanc-cli register-thumbnails [--dll <path>]\n\
           shibanc-cli unregister-thumbnails\n\
           shibanc-cli register-associations [--exe <path>]\n\
           shibanc-cli unregister-associations\n\
           shibanc-cli install-linux-thumbnailer"
    );
}

fn parse_material(s: &str) -> Option<MaterialPreset> {
    match s.to_ascii_lowercase().as_str() {
        "alu" | "aluminum" | "0" => Some(MaterialPreset::Aluminum6061),
        "wood" | "rosewood" | "1" => Some(MaterialPreset::Rosewood),
        "brass" | "2" => Some(MaterialPreset::Brass),
        "jade" | "3" => Some(MaterialPreset::Jade),
        "pine" | "pinewood" | "4" => Some(MaterialPreset::PineWood),
        "heatmap" | "depth" | "5" => Some(MaterialPreset::DepthHeatmap),
        _ => None,
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        print_usage();
        return ExitCode::from(1);
    }

    match args[0].as_str() {
        "thumb" | "render" => {
            let mut input: Option<PathBuf> = None;
            let mut output: Option<PathBuf> = None;
            let mut size: u32 = 512;
            let mut material: Option<MaterialPreset> = None;
            let mut grid_res: Option<u32> = None;

            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "-i" | "--input" if i + 1 < args.len() => {
                        input = Some(PathBuf::from(&args[i + 1]));
                        i += 2;
                    }
                    "-o" | "--output" if i + 1 < args.len() => {
                        output = Some(PathBuf::from(&args[i + 1]));
                        i += 2;
                    }
                    "-s" | "--size" if i + 1 < args.len() => {
                        size = args[i + 1].parse().unwrap_or(512);
                        i += 2;
                    }
                    "-g" | "--grid" if i + 1 < args.len() => {
                        grid_res = args[i + 1].parse().ok();
                        i += 2;
                    }
                    "-m" | "--material" if i + 1 < args.len() => {
                        material = parse_material(&args[i + 1]);
                        i += 2;
                    }
                    _ => i += 1,
                }
            }

            let (Some(inp), Some(out)) = (input, output) else {
                eprintln!("错误: 请指定 -i <输入文件> 和 -o <输出 PNG>");
                return ExitCode::from(2);
            };

            let mut opts = RenderOptions::for_os_thumbnail(size);
            if let Some(m) = material {
                opts.material = Some(m);
            }
            if let Some(g) = grid_res {
                opts.grid_max_dim = g.clamp(128, 2048);
            }
            if size >= 768 {
                opts.grid_max_dim = opts.grid_max_dim.max(1024);
                opts.show_floor = true;
            }

            if let Some(parent) = out.parent() {
                if !parent.as_os_str().is_empty() {
                    let _ = fs::create_dir_all(parent);
                }
            }

            match render_file_to_png(&inp, &out, &opts) {
                Ok(()) => {
                    println!("已渲染预览图: {}", out.display());
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("渲染失败: {}", e);
                    ExitCode::from(3)
                }
            }
        }
        "export-stl" => {
            let mut input: Option<PathBuf> = None;
            let mut output: Option<PathBuf> = None;
            let mut grid_res: u32 = 768;

            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "-i" | "--input" if i + 1 < args.len() => {
                        input = Some(PathBuf::from(&args[i + 1]));
                        i += 2;
                    }
                    "-o" | "--output" if i + 1 < args.len() => {
                        output = Some(PathBuf::from(&args[i + 1]));
                        i += 2;
                    }
                    "-g" | "--grid" if i + 1 < args.len() => {
                        grid_res = args[i + 1].parse().unwrap_or(768);
                        i += 2;
                    }
                    _ => i += 1,
                }
            }

            let (Some(inp), Some(out)) = (input, output) else {
                eprintln!("错误: 请指定 -i <输入文件> 和 -o <输出 STL>");
                return ExitCode::from(2);
            };

            match parse_file(&inp) {
                Ok(prog) => match export_program_binary_stl(&prog, grid_res, None, &out) {
                    Ok(tris) => {
                        println!("已导出闭合二进制 STL 三维网格 ({} 个三角面): {}", tris, out.display());
                        ExitCode::SUCCESS
                    }
                    Err(e) => {
                        eprintln!("STL 导出失败: {}", e);
                        ExitCode::from(3)
                    }
                },
                Err(e) => {
                    eprintln!("G 代码解析失败: {}", e);
                    ExitCode::from(3)
                }
            }
        }
        "inspect" => {
            let Some(path_str) = args.get(1) else {
                eprintln!("错误: 请提供 G 代码文件路径");
                return ExitCode::from(2);
            };
            match parse_file(Path::new(path_str)) {
                Ok(prog) => {
                    let summary = serde_json::json!({
                        "stats": prog.stats,
                        "inferred_stock": prog.stock,
                        "inferred_tool": prog.tool,
                    });
                    println!("{}", serde_json::to_string_pretty(&summary).unwrap_or_default());
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("解析失败: {}", e);
                    ExitCode::from(3)
                }
            }
        }
        "generate-samples" => {
            let mut dir = PathBuf::from("samples");
            if args.len() >= 3 && (args[1] == "-d" || args[1] == "--dir") {
                dir = PathBuf::from(&args[2]);
            }
            if let Err(e) = fs::create_dir_all(&dir) {
                eprintln!("创建目录失败: {}", e);
                return ExitCode::from(3);
            }
            let tap_path = dir.join("lotus_relief_medallion.tap");
            let nc_path = dir.join("aerospace_bearing_housing.nc");

            fs::write(&tap_path, generate_relief_tap_sample()).expect("write tap");
            fs::write(&nc_path, generate_mechanical_nc_sample()).expect("write nc");
            println!("已生成示例刀路文件:\n  1. {}\n  2. {}", tap_path.display(), nc_path.display());
            ExitCode::SUCCESS
        }
        "register-thumbnails" => {
            let mut dll_override: Option<PathBuf> = None;
            if args.len() >= 3 && args[1] == "--dll" {
                dll_override = Some(PathBuf::from(&args[2]));
            }
            match shibanc_thumb_win::register_os_thumbnails(dll_override.as_deref()) {
                Ok(p) => {
                    println!(
                        "已成功注册 Windows 资源管理器缩略图扩展 (.tap / .nc / .gcode / .cnc):\n  DLL: {}",
                        p
                    );
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("注册失败: {}", e);
                    ExitCode::from(3)
                }
            }
        }
        "unregister-thumbnails" => {
            let _ = shibanc_thumb_win::unregister_os_thumbnails();
            println!("已移除系统缩略图扩展注册。");
            ExitCode::SUCCESS
        }
        "register-associations" => {
            let mut exe_override: Option<PathBuf> = None;
            if args.len() >= 3 && args[1] == "--exe" {
                exe_override = Some(PathBuf::from(&args[2]));
            }
            match shibanc_thumb_win::register_os_file_associations(exe_override.as_deref()) {
                Ok(p) => {
                    println!("已成功注册 .nc / .tap / .gcode / .cnc 系统默认打开方式:\n  目标程序: {}", p);
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("注册文件关联失败: {}", e);
                    ExitCode::from(3)
                }
            }
        }
        "unregister-associations" => {
            let _ = shibanc_thumb_win::unregister_os_file_associations();
            println!("已移除 .nc / .tap 系统默认打开方式注册。");
            ExitCode::SUCCESS
        }
        "install-linux-thumbnailer" => {
            let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
            let exe = env::current_exe().unwrap_or_else(|_| PathBuf::from("shibanc-cli"));
            let mime_dir = Path::new(&home).join(".local/share/mime/packages");
            let thumb_dir = Path::new(&home).join(".local/share/thumbnailers");
            let _ = fs::create_dir_all(&mime_dir);
            let _ = fs::create_dir_all(&thumb_dir);

            let mime_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-shibanc-gcode">
    <comment>CNC G-Code Toolpath</comment>
    <glob pattern="*.tap"/>
    <glob pattern="*.nc"/>
    <glob pattern="*.gcode"/>
    <glob pattern="*.cnc"/>
  </mime-type>
</mime-info>
"#;
            let thumbnailer_entry = format!(
                "[Thumbnailer Entry]\nTryExec={exe}\nExec={exe} thumb -i %i -o %o -s %s\nMimeType=application/x-shibanc-gcode;text/x-gcode;application/x-gcode;\n",
                exe = exe.display()
            );

            let _ = fs::write(mime_dir.join("shibanc-gcode.xml"), mime_xml);
            let _ = fs::write(thumb_dir.join("shibanc.thumbnailer"), thumbnailer_entry);
            println!(
                "已写入 Linux Freedesktop 缩略图配置:\n  {}\n  {}\n提示: 运行 `update-mime-database ~/.local/share/mime` 生效。",
                mime_dir.join("shibanc-gcode.xml").display(),
                thumb_dir.join("shibanc.thumbnailer").display()
            );
            ExitCode::SUCCESS
        }
        _ => {
            print_usage();
            ExitCode::from(1)
        }
    }
}
