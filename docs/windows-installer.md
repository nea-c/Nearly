# Windows installer

Run `npm run build:installer -- --offline` on Windows x64 with existing MSVC, Rust, Node and cached Tauri NSIS tools. This builds but never executes the versioned setup file, for example `build/Nearly_r3.0_x64-setup.exe`. The application developer build remains `npm run build:windows -- --offline`. Existing outputs are backed up under build/previous before replacement. No new dependencies or runtime are downloaded automatically.

Setup installs for the current user in `%LOCALAPPDATA%\Nearly` without elevation. It automatically creates `%LOCALAPPDATA%\Nearly\uninstall.exe`. Separate Start menu and desktop checkboxes preserve independent choices across upgrades. Setup refuses a running installed app and never force-stops syncs. WebView2 must already be installed; missing runtime produces an explanation instead of installing additional software.

Settings remain beside Nearly.exe. The current format is the complete five-document set `settings.json`, `history.json`, `bookmarks.json`, `sync-profiles.json` and `connections.json`; see storage-format.md. Upgrades preserve settings, and uninstall removes only owned application payload/shortcuts, retaining settings, backups and other user files. Installing does not copy settings from a portable copy or convert the legacy r1 single-document format. Back up all settings and backups before an intentional migration; never mix incomplete sets or overwrite legacy data to bypass a load error.

Automatic installer handoff accepts only the owned, registered
`%LOCALAPPDATA%\Nearly\Nearly.exe` installation. A portable development copy such
as `D:\Codex\Nearly\build\Nearly.exe` is outside that scope: it is neither moved
nor updated by this path. Creating a Start menu shortcut to that copy does not
register an installation, change its version, or install a release. Existing r1/r2
copies have no production update trust anchor: install the first supported signed
release manually with its official setup. Subsequent newer correctly signed
releases can use the registered installation's updater. A first trusted manual
installer bootstrap requires an explicit installation request; no installer is
executed by the build or generated-data tests.

Local builds do not sign a release. The official release workflow creates a detached minisign `.sig` for the update verifier; this is not Windows Authenticode signing and does not guarantee that Windows/SmartScreen will omit unknown-publisher warnings. The registered production updater gate is enabled; see startup-updates.md for its ownership and idle requirements.

Verification includes browser geometry/regression checks, source policy tests, failure-injected publication rollback, and compilation with cached NSIS. Hosted isolated QA-feature install/reinstall/uninstall and update success/health-failure rollback passed; see windows-installer-qa.md. Those results do not qualify ordinary-PC production installation, arbitrary power loss or long-duration operation. Setup is not executed on this host.

See [the template and provenance](../src-tauri/windows/README.md) for exact ownership rules and limitations.

Production updater handoff is enabled with the fixed registered public key after explicit activation approval. The isolated hosted success and rollback cases passed; see windows-installer-qa.md. No installer is executed on this host, and production activation does not publish a release.

Setup and uninstaller captions, branding, installed-app DisplayVersion, and installer file/product version strings use the public `rX.Y` release label. Numeric Windows version resources use `X.Y.0.0`. The separate `NearlyInternalVersion` registry value uses `X.Y.0`, preserving numeric downgrade checks and compatibility with older numeric DisplayVersion registrations. All values derive from version.json; see versioning.md.

## Public release build privacy

Before publishing, rebuild with Rust `--remap-path-prefix` for the developer profile and workspace roots. Native MSVC dependencies also require `/experimental:deterministic` with `/pathmap:<source>=<anonymous-prefix>` in `CFLAGS`; Rust remapping alone does not cover C/C++ `__FILE__` strings. Use only build-subprocess environment variables, preserve existing flags, and inspect both the application payload and setup for personal paths before uploading. Do not distribute PDBs, local build metadata, settings, backups, test fixtures or diagnostic outputs.
