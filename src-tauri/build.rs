fn main() {
    println!("cargo:rerun-if-changed=../version.json");
    // include_image! embeds generated RGBA; track the original PNG inputs too.
    for badge in ["sync", "done", "error", "paused"] {
        println!("cargo:rerun-if-changed=icons/badges/{badge}.png");
    }
    let source = include_str!("../version.json");
    let canonical: String = source.chars().filter(|c| !c.is_whitespace()).collect();
    let version = env!("CARGO_PKG_VERSION");
    let parts: Vec<_> = version.split('.').collect();
    assert!(parts.len() == 3 && parts[2] == "0" && parts[..2].iter().all(|part|
        part.parse::<u16>().is_ok_and(|value| value.to_string() == *part)),
        "Release versions must be canonical X.Y.0 with Windows-compatible components");
    assert_eq!(canonical, format!("{{\"version\":\"{}\"}}", env!("CARGO_PKG_VERSION")),
        "Cargo version differs from version.json; run npm run version:sync");
    tauri_build::build()
}
