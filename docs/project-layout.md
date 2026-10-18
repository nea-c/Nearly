# Project layout

Nearly is a Windows desktop application built with TypeScript and Tauri 2/Rust. The production identifier is `local.syncfiles.native`. The source can be checked out in any project directory.

| Path | Purpose |
| --- | --- |
| `src/`, `index.html`, `drag-preview.html` | UI, styles and the isolated drag preview |
| `src-tauri/src/` | Native SFTP, synchronization, ownership and window lifecycle |
| `src-tauri/vendor/` | Patched upstream SFTP dependency, with its original license |
| `src-tauri/icons/`, `src-tauri/capabilities/` | Application resources and permission declarations |
| `package*.json`, `src-tauri/Cargo.lock` | Dependency manifests and lockfiles |
| `tests/`, `playwright*.config.ts` | Model tests and mocked browser workflows |
| `scripts/build-windows.mjs` | Local Windows build and safe artifact publication |
| Selected fixture/acceptance scripts | Opt-in generated localhost SFTP and isolated native checks |
| Selected `docs/*.md` | Public operation, layout and validation guidance |

## Local files kept out of Git

Build outputs, dependency caches, generated schemas, test results, diagnostics, historical operational notes, backups, screenshots, personal settings and generated credentials remain local. Source assets such as the app icon and third-party license are retained. Do not distribute the entire build directory: launching the application may create personal settings there.

## Building

Use `npm ci`, then `npm run build:windows` on a Windows host with Rust/MSVC and WebView2. The command enforces Cargo.lock, builds without an installer, validates the PE artifact, and publishes only Nearly.exe and build-info.json into build/. Previous copies of these two files are retained in build/previous/. It does not write, move or restore adjacent settings files. An explicit CARGO_TARGET_DIR is resolved from the project root. Use --offline only after dependencies have been cached.

## Tests

Model and browser tests use synthetic fixtures. Browser tests use installed Microsoft Edge and dedicated local ports; an unrelated server on the same port must be closed. Native scripts are opt-in and require a deliberately isolated executable/configuration. The current hash-gated drag/launch runner requires its QA identifier and exact executable hash; follow the native QA guide. Test credentials are generated at runtime, not stored in source. No acceptance harness runs as part of build:windows.

## Settings

The five primaries settings.json, history.json, bookmarks.json, sync-profiles.json and connections.json, plus their per-file *.backup.json recovery copies, live beside the running executable. See [storage format](storage-format.md) for manifest consistency, interrupted-save recovery and explicit external conversion. A write failure does not redirect settings elsewhere. SYNCFILES_CONFIG_DIR is an explicit override for isolated development/test fixtures; do not set it for normal use. Profiles and paths are personal data and must not be committed. Passwords, passphrases and private key contents must not be saved in application settings or logs.
