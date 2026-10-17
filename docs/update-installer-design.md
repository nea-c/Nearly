# Signed installer updates beside Nearly.exe

Status: design only. The distribution choice is a per-user NSIS installer. A downloaded update installer must be stored in the same directory as the currently running Nearly.exe, and installation must preserve adjacent settings and the user's two shortcut choices. This document does not authorize generating signing keys, publishing releases, running an installer, or changing a user installation.

## Official API boundary

Research checked the published `tauri-plugin-updater` `updater-v2.14.0` source on 2026-10-17. Pin and review the actual plugin version before integrating it; it is not currently an installed project dependency.

The Rust `Update::download` method collects the package in memory and verifies its signature before returning successful bytes. Its download-finished callback runs before verification, so that callback must never enable installation. `Update::verify` can authenticate bytes again, including a staged file read back from disk.

On Windows, `Update::install` verifies bytes, stages/extracts the installer in an operating-system temporary directory, launches it, and exits the application. `executable_path` does not redirect this staging directory. Therefore calling `install` or `download_and_install` would violate the required sibling-directory placement. Use the official verifier and a separately reviewed Nearly staging/handoff coordinator instead.

The Windows helper reports launch failures but does not await installer completion or provide application-level rollback, cross-window idle arbitration, or a health-confirmed restart. Its launch-before-exit hook cannot return a veto result. Do not present these facilities as transactional installer rollback.

## Trust and release prerequisites

Keep installation unavailable until an owner-approved signing public key is embedded in the application and a release workflow produces signed NSIS artifacts. Private signing material stays outside source, diagnostics and logs. No private key has been generated as part of this work.

Use a fixed repository/HTTPS manifest location, strict stable SemVer precedence, an exact Windows architecture and NSIS target, and an explicit artifact-size limit. Reject drafts, prereleases, equal/older versions, malformed metadata and unexpected locations. Apply HTTPS and redirect policy to artifact requests as well as manifests; do not assume the plugin's artifact request enforces the same policy as its endpoint validation.

Installation is available only when the canonical current Nearly.exe path matches the registered per-user installation location. A portable copy in another directory must not launch an installer that silently switches the app and adjacent settings to LocalAppData. It may report that installer updating is unavailable for that layout. Fresh installation likewise never discovers, copies or migrates another portable copy's configuration automatically.

Require authenticated version binding, not just an authentic historical installer. In the researched plugin, `requireSignedVersion` is opt-in and defaults to false. Enable it only with a signing toolchain that emits the corresponding authenticated version comment; reject missing or mismatched signed versions. Check this against the chosen CLI version before release. Signatures, architecture compatibility and a GitHub-provided digest serve different purposes; a digest alone is not publisher authentication.

The official download helper has no application package-size bound. Either provide a reviewed cancellation/budget wrapper around it, or stream a bounded native download and use `Update::verify` for official signature validation. Never substitute unsigned release metadata for verification.

## Sibling-directory staging

Resolve the parent from the actual native current-executable path. Do not accept a directory or filename supplied by a renderer or release notes. Use an application-generated, versioned, random sibling name, distinct from Nearly.exe, uninstall.exe, settings.json and settings.backup.json. Create files exclusively; never overwrite an existing path.

For streaming, use a sibling partial file, enforce size/time limits, flush and close it, verify the complete bytes, then finalize to a sibling setup filename without replacement. Reject reparse-point/path substitutions and unwritable or locked locations without elevation or fallback to Temp. Re-read/re-verify cached or staged content before handoff and protect it against replacement during launch. Remove only files created by this attempt. Never recursively clean the application directory.

## Process-wide handoff

One native coordinator owns discovery, prompt, download and installation state. Later/dismissal is process-local and must not create a persistent suppression preference. Additional windows and second EXE invocations cannot create another prompt or installer.

Installation must refuse while any window owns running/starting/stopping syncs, connection attempts, file/archive operations, host approvals, transfers, queued native work or unsettled settings writes. Do not stop a user's active sync merely to update. After all participating windows acknowledge settled persistent preferences, acquire a native update seal that prevents new work, tab transfers, window creation and conflicting settings writes; recheck global idle under that seal. Avoid holding registry/settings locks across UI dispatch.

Update shutdown uses one controlled process-wide lifecycle path and may reuse appropriate existing cleanup semantics. Stopped tab context is session-only: prune owned transient stopped records and do not restore tabs or syncs after restart. Preserve profiles, browse preferences, mappings, presets, trust and shortcut choices. Do not retain invisible stopped records that consume future capacity. Stop background watchers/workers and close the entire native process through the update coordinator, without forcing any active sync to stop.

The custom installer refuses a running Nearly process. Consequently the updater needs an explicit handoff: launch the verified sibling installer with a narrowly defined update mode that waits, without killing, for the exact old process to exit before touching files or registry. Bind any parent-process wait to native process identity/handle, bound the wait, and fail closed. The old process cannot execute a launch after it has exited; a prelaunched waiting installer or a reviewed owned helper is necessary. Do not use a shell script, release-supplied arguments, forced termination, or elevation to bridge this sequence.

Use explicit native application paths and correctly encoded fixed arguments. Installer update mode must preserve the existing install location and both persisted shortcut booleans, including false. Adjacent settings and backups are never installer payload or uninstall targets. Restart only after successful installation; restarting must not authenticate or resume sync automatically.

## Failure and verification boundary

Download, signature, compatibility, staging or idle-check failures leave the current app usable. Before irreversible shutdown, cancel the update seal on failure. If installer launch fails, retain the current windows where possible and show a concrete retryable error. After process exit, installer cancellation/failure must leave understandable recovery instructions and the persistent preferences. Backup/replacement recovery and health-confirmed restart require their own implementation and tests; neither NSIS nor the official updater is assumed to make the whole transaction atomic.

Required isolated Windows tests include tampered/missing signatures and signed versions, disk-full/locked/unwritable sibling staging, filename collisions, portable-versus-registered-install layout mismatch, busy work in another window, simultaneous launches, parent-wait timeout, installer cancellation/failure, interrupted replacement/restart, all four shortcut combinations across upgrades, and settings preservation through install/upgrade/uninstall. Check that application shutdown removes only owned session context; take the installer byte-preservation baseline after that intentional application cleanup. Restart must not restore stopped tabs, authenticate or start jobs. No suitable isolated Windows runtime has been identified here; no host installation or registry/shortcut test is claimed.

## Primary sources

- [Published updater source, v2.14.0](https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.14.0/plugins/updater/src/updater.rs)
- [Published updater configuration, v2.14.0](https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.14.0/plugins/updater/src/config.rs)
- [Rust Update API](https://docs.rs/tauri-plugin-updater/2.14.0/tauri_plugin_updater/struct.Update.html)
- [Official updater guide](https://v2.tauri.app/plugin/updater/)
- [Tauri CLI 2.12.3 NSIS template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)

Implementation update (2026-10-17): `update_package.rs`, `startup_update.rs`, `update_handoff.rs`, global ownership/settings settlement and localized UI now implement the independently testable boundaries described here. Production trust remains absent and an additional `HANDOFF_RELEASE_VALIDATED=false` gate prevents installer execution until isolated release verification. Consult startup-updates.md for actual code behavior, known retained staging files and post-exit rollback limitations; do not interpret this design as completed real installation testing.
