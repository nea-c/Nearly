# Windows installer

Run `npm run build:installer -- --offline` on Windows x64 with existing MSVC, Rust, Node and cached Tauri NSIS tools. This builds but never executes the versioned setup file, for example `build/Nearly_r3.0_x64-setup.exe`. The application developer build remains `npm run build:windows -- --offline`. Existing outputs are backed up under build/previous before replacement. No new dependencies or runtime are downloaded automatically.

The local selectable-destination candidate installs for the current user without elevation. On a fresh interactive install, choose a dedicated folder (default `%LOCALAPPDATA%\Nearly`), then independently choose **Create a Start menu shortcut** / **スタートメニューに登録する** and **Create a desktop shortcut** / **デスクトップショートカットを作成する**. This extends the existing shortcut page; there is no duplicate desktop checkbox on Finish. `uninstall.exe` is created beside `Nearly.exe`. This source change is local and has not changed the published r3.0 installer.

An owned existing installation fixes the destination to its registered folder. Reinstall and automatic update keep that folder and the separate shortcut choices, including saved unchecked choices and shortcuts removed by the user. An update does not move an installation or recreate a removed shortcut. Use the normal installed uninstaller when intentionally removing an installation; selecting another directory is not a migration procedure. Existing r3.0 installations at the default location remain supported.

Choose an absolute folder such as `D:\Nearly` or `E:\Nearly` on a local fixed NTFS drive with an existing parent. The path must be at most 176 UTF-16 code units and fit the recovery record's 512 UTF-8 byte limit. Windows must permit actual file creation and writing. New folders inherit normal permissions; setup does not require private ACLs on every ancestor, replace an existing empty folder, or change existing ACLs. Fresh folders must be empty, absent, or contain only recognized Nearly settings/backups and WebView data after uninstall. Network shares, device paths, drive roots, ambiguous names and links/junctions remain unsupported. Retained directory handles, regular single-link payload checks and same-handle I/O protect the operation's scope. Setup never repairs permissions, requests elevation or adopts a foreign EXE/uninstaller. It refuses a running installed app and never force-stops syncs. WebView2 must already be installed; missing runtime produces an explanation instead of installing additional software.

Settings remain beside Nearly.exe. The current format is the complete five-document set `settings.json`, `history.json`, `bookmarks.json`, `sync-profiles.json` and `connections.json`; see storage-format.md. Upgrades preserve settings. Uninstall defaults to retaining settings, backups and other user files while removing owned payload/shortcuts. Installing does not copy settings from a portable copy or convert the legacy r1 single-document format. Back up all settings and backups before an intentional migration; never mix incomplete sets or overwrite legacy data to bypass a load error.

Interactive uninstall also offers **Delete the installation folder and ALL its contents**, initially OFF. ON means the actual registered folder itself (for example `D:\Nearly`) and everything inside, including settings and unrelated files placed there. It requires a second confirmation showing the exact target, with No as the default. Declining does not delete anything. Silent uninstall keeps the option OFF. This does not delete the drive or data outside the registered folder.

Uninstall requires the executing image to match the complete registered uninstaller bytes. This permits NSIS's normal temporary execution and identical copies, while rejecting a stale/modified copy or a missing registered image. Whole-folder removal additionally requires the recorded directory identity, rejects important roots and ancestors, and refuses reparse points, hardlinks and changed identities. Bounded traversal deletes through inspected live handles; it does not follow links or use recursive path deletion. A lock, read-only file, race or interruption can leave a partially removed folder. Failures report a nonzero result and retain registration where possible; deletion is not an atomic transaction. Legacy registrations without a recorded root identity cannot enable full removal until a valid explicit reinstall records it.

Automatic installer handoff accepts only the owned, validated per-user registered
installation, and requires the running `Nearly.exe` to match that installation.
Root guards remain held while transaction/recovery guards are acquired. A portable development copy such
as `D:\Codex\Nearly\build\Nearly.exe` is outside that scope: it is neither moved
nor updated by this path. Creating a Start menu shortcut to that copy does not
register an installation, change its version, or install a release. Existing r1/r2
copies have no production update trust anchor: install the first supported signed
release manually with its official setup. Subsequent newer correctly signed
releases can use the registered installation's updater. A first trusted manual
installer bootstrap requires an explicit installation request; no installer is
executed by the build or generated-data tests.

Local builds do not sign a release. The official release workflow creates a detached minisign `.sig` for the update verifier; this is not Windows Authenticode signing and does not guarantee that Windows/SmartScreen will omit unknown-publisher warnings. The registered production updater gate is enabled; see startup-updates.md for its ownership and idle requirements.

Verification includes source policy tests, failure-injected publication rollback, cached NSIS compilation and disposable hosted lifecycle checks. See [windows-installer-qa.md](windows-installer-qa.md) for exact commits and results, including the new whole-folder option and the remaining failures. Passing native fixtures or individual lifecycle scenarios do not qualify the entire candidate. Setup is not executed on this host. Ordinary-PC production installation, arbitrary power loss and long-duration operation remain unqualified.

See [the template and provenance](../src-tauri/windows/README.md) for exact ownership rules and limitations.

Production updater handoff is enabled with the fixed registered public key after explicit activation approval. The isolated hosted success and rollback cases passed; see windows-installer-qa.md. No installer is executed on this host, and production activation does not publish a release.

Setup and uninstaller captions, branding, installed-app DisplayVersion, and installer file/product version strings use the public `rX.Y` release label. Numeric Windows version resources use `X.Y.0.0`. The separate `NearlyInternalVersion` registry value uses `X.Y.0`, preserving numeric downgrade checks and compatibility with older numeric DisplayVersion registrations. All values derive from version.json; see versioning.md.

## Public release build privacy

Before publishing, rebuild with Rust `--remap-path-prefix` for the developer profile and workspace roots. Native MSVC dependencies also require `/experimental:deterministic` with `/pathmap:<source>=<anonymous-prefix>` in `CFLAGS`; Rust remapping alone does not cover C/C++ `__FILE__` strings. Use only build-subprocess environment variables, preserve existing flags, and inspect both the application payload and setup for personal paths before uploading. Do not distribute PDBs, local build metadata, settings, backups, test fixtures or diagnostic outputs.
