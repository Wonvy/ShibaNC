use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=SHIBANC_WIN7");
    println!("cargo:rerun-if-env-changed=SHIBANC_YY_THUNKS_OBJ");

    let win7_enabled = env::var_os("CARGO_FEATURE_WIN7").is_some()
        || env::var("SHIBANC_WIN7").map(|v| v == "1").unwrap_or(false);

    if win7_enabled && env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
        let default_obj = manifest_dir
            .join("../../target/yy-thunks/x64/YY_Thunks_for_Win7.obj");
        let obj_path = env::var("SHIBANC_YY_THUNKS_OBJ")
            .map(PathBuf::from)
            .unwrap_or(default_obj);

        if !obj_path.exists() {
            panic!(
                "Win7 build requires YY_Thunks_for_Win7.obj at {} (run scripts/build-win7.ps1 to download automatically)",
                obj_path.display()
            );
        }

        println!("cargo:rustc-link-arg={}", obj_path.display());
        println!("cargo:rustc-link-arg=delayimp.lib");
        println!("cargo:rustc-link-arg=/DELAYLOAD:d3dcompiler_47.dll");
        println!("cargo:rustc-link-arg=/NODEFAULTLIB:ucrt.lib");
        println!("cargo:rustc-link-arg=libucrt.lib");
        println!("cargo:rustc-link-arg=/NODEFAULTLIB:vcruntime.lib");
        println!("cargo:rustc-link-arg=libvcruntime.lib");
        println!("cargo:rustc-link-arg=/NODEFAULTLIB:msvcrt.lib");
        println!("cargo:rustc-link-arg=libcmt.lib");
        println!("cargo:rustc-link-arg-bins=/SUBSYSTEM:WINDOWS,6.01");
        println!("cargo:rustc-link-arg-bins=/OSVERSION:6.1");
    }

    tauri_build::build()
}
