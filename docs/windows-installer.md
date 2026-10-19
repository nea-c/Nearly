# Windows installer

Run `npm run build:installer -- --offline` on Windows x64 with existing MSVC, Rust, Node and cached Tauri NSIS tools. This builds but never executes the versioned setup file, for example `build/Nearly_r2.0_x64-setup.exe`. The application developer build remains `npm run build:windows -- --offline`. Existing outputs are backed up under build/previous before replacement. No new dependencies or runtime are downloaded automatically.

Setup installs for the current user in `%LOCALAPPDATA%\Nearly` without elevation. It automatically creates `%LOCALAPPDATA%\Nearly\uninstall.exe`. Separate Start menu and desktop checkboxes preserve independent choices across upgrades. Setup refuses a running installed app and never force-stops syncs. WebView2 must already be installed; missing runtime produces an explanation instead of installing additional software.

Settings remain beside Nearly.exe. Upgrades preserve them, and uninstall removes only owned application payload/shortcuts, retaining settings, backups and other user files. Installing does not silently copy settings from another portable copy. Use the existing developer EXE for the current portable layout until an intentional migration is arranged.

Automatic installer handoff accepts only the owned, registered
`%LOCALAPPDATA%\Nearly\Nearly.exe` installation. A portable development copy such
as `D:\Codex\Nearly\build\Nearly.exe` is outside that scope: it is neither moved
nor updated by this path. Creating a Start menu shortcut to that copy does not
register an installation, change its version, or install a release. The existing
shortcut in this workspace still targets the preserved 1.0.0-labelled development
copy. Do not describe it as an installed r2.0 upgrade. A first trusted manual
installer bootstrap requires an explicit installation request; no installer is
executed by the build or generated-data tests.

This local installer is unsigned; Windows may show an unknown-publisher warning. No signing key, ACL change or publishing was performed. The executable-directory update installer behavior is documented in update-installer-design.md and is not enabled yet.

Verification includes browser geometry/regression checks, source policy tests, failure-injected publication rollback, and compilation with cached NSIS. Real install/upgrade/uninstall, shortcut UI and registry effects must still be tested in a disposable Windows environment. No suitable isolated Windows runtime is available on this host; the setup is not executed here.

See [the template and provenance](../src-tauri/windows/README.md) for exact ownership rules and limitations.

Production updater handoff is enabled with the fixed registered public key after explicit activation approval. The isolated hosted success and rollback cases passed; see windows-installer-qa.md. No installer is executed on this host, and production activation does not publish a release.

Setup and uninstaller captions, branding, installed-app DisplayVersion, and installer file/product version strings use the public `rX.Y` release label. Numeric Windows version resources use `X.Y.0.0`. The separate `NearlyInternalVersion` registry value uses `X.Y.0`, preserving numeric downgrade checks and compatibility with older numeric DisplayVersion registrations. All values derive from version.json; see versioning.md.

## Public release build privacy

Before publishing, rebuild with Rust `--remap-path-prefix` for the developer profile and workspace roots. Native MSVC dependencies also require `/experimental:deterministic` with `/pathmap:<source>=<anonymous-prefix>` in `CFLAGS`; Rust remapping alone does not cover C/C++ `__FILE__` strings. Use only build-subprocess environment variables, preserve existing flags, and inspect both the application payload and setup for personal paths before uploading. Do not distribute PDBs, local build metadata, settings, backups, test fixtures or diagnostic outputs.
