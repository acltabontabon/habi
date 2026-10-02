use std::path::PathBuf;

fn main() {
    // Tauri embeds its Windows manifest (Common Controls v6, needed by the
    // dialog APIs) into the application binary only, so test binaries that
    // link Tauri fail to start on Windows (STATUS_ENTRYPOINT_NOT_FOUND).
    // Embed the same manifest through the linker instead, for every binary
    // this crate links: the app and its tests alike.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let windows = if target_os == "windows" && target_env == "msvc" {
        let manifest =
            PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
                .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        tauri_build::WindowsAttributes::new_without_app_manifest()
    } else {
        tauri_build::WindowsAttributes::new()
    };
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}
