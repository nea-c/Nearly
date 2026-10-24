#[path = "src/version.rs"]
#[allow(dead_code)]
mod version;
mod windows_version_resource;

fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=../version.json");
    // include_image! embeds generated RGBA; track the original PNG inputs too.
    for badge in ["sync", "done", "error", "paused"] {
        println!("cargo:rerun-if-changed=icons/badges/{badge}.png");
    }
    let source = include_str!("../version.json");
    let canonical: String = source.chars().filter(|c| !c.is_whitespace()).collect();
    let version = env!("CARGO_PKG_VERSION");
    let parsed=semver::Version::parse(version).expect("Canonical version");
    assert_eq!(version::distribution_version(&version::display_label(&parsed)),Some(parsed),"Canonical milestone or pre.N required");
    assert_eq!(canonical, format!("{{\"version\":\"{}\"}}", env!("CARGO_PKG_VERSION")),
        "Cargo version differs from version.json; run npm run version:sync");
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let display = version::display_label(&semver::Version::parse(version).expect("Canonical version"));
        let rc = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo OUT_DIR")).join("resource.rc");
        let generated = std::fs::read_to_string(&rc).expect("Tauri generated resource source");
        let displayed = windows_version_resource::display_versions(&generated, version, &display)
            .expect("Tauri resource version strings changed; review the generator before building");
        // Preserve Tauri's entire RC (icon, manifest, language and fixed numeric
        // fields). Recompile the same OUT_DIR/resource.lib before the linker
        // runs. An empty binary list suppresses duplicate Cargo linker inputs;
        // tauri_build already emitted the link instruction for this exact file.
        // set_resource_file accepts RC contents in pinned tauri-winres 0.3.6.
        tauri_winres::WindowsResource::new().set_resource_file(&displayed)
            .compile_for(&[]).expect("Compile public version resource strings");
    }
}
