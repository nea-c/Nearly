# Nearly Windows installer template

`installer.nsi` is a narrowly scoped per-user NSIS template. The application is
self-contained; its only installed payloads are `Nearly.exe` and NSIS's generated
`uninstall.exe`. Runtime installation/download, elevation, file associations,
legacy MSI migration, and arbitrary external resources are intentionally absent.

## Required Tauri configuration

The root packaging configuration must enable the `nsis` target and set:

```json
{
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "windows": {
      "webviewInstallMode": { "type": "skip" },
      "nsis": {
        "template": "windows/installer.nsi",
        "installMode": "currentUser",
        "installerIcon": "icons/icon.ico",
        "languages": ["English", "Japanese"]
      }
    }
  }
}
```

Do not configure external resources/binaries for this template: compile-time
guards reject them. The install folder is fixed to the current user's
`%LOCALAPPDATA%\Nearly`; `/D=` and stored alternative paths cannot redirect it.
A create-new, delete-on-close write probe must succeed before payload extraction.
There is no administrator mode, directory selector, or runtime bootstrapper.
Existing target EXE/uninstaller files require a matching owned uninstall
registration and exact installation location before any overwrite. A settings-only
folder is a valid reinstall target. Reparse-point target directories are rejected
for both installation and uninstallation.

## Shortcuts and upgrades

One custom page contains separate Start menu and desktop checkboxes. Defaults
are Start menu enabled, desktop disabled. Both DWORD values are read separately
from `HKCU\Software\<bundle identifier>\Installer`; absent values receive defaults,
whereas explicit zero remains zero. Normal interactive upgrades show these saved
choices. `/S` and `/P` use the saved choices without showing the page.
On an existing owned installation, a manually removed previously enabled shortcut
is inferred as unchecked before the page is shown, so silent/passive upgrades
preserve its absence. The user can explicitly recheck it to recreate it. Fresh
installation or reinstall after uninstall uses the saved preferences/defaults.

Install/upgrade creates or removes each selected shortcut independently. It
touches an existing shortcut only when COM resolves its target to this installed
Nearly EXE; a foreign shortcut with the same name remains unchanged. `/NS` skips
shortcut changes for that invocation and leaves the saved choices unchanged.
There is no second desktop checkbox on the finish page and no separate stock
Start menu page. Upgrades replace payload in place without invoking an older
uninstaller, so a saved disabled preference cannot be lost during maintenance.

## Running app and runtime prerequisite

Both installer and uninstaller use Restart Manager only to query whether the
installed EXE is in use. Busy status and query failures abort, including in silent
or passive mode. Neither code path calls shutdown, restart, process termination,
or an old uninstaller. This preserves running syncs and their backend process.

Before installation changes, the installer checks the standard Microsoft
WebView2 Evergreen registration keys in HKLM/HKCU and both registry views. Missing
runtime blocks setup with a localized explanation to install the runtime from
Microsoft separately. It never downloads or executes a runtime installer.

## Settings and uninstall

The Add/Remove Programs entry points to the automatically generated
`%LOCALAPPDATA%\Nearly\uninstall.exe`. The uninstaller validates its fixed per-user
location and owned registry marker, refuses a running app, removes only the known
main EXE, its own uninstaller, target-matching shortcuts, and its own uninstall
registration. Directory removal is **nonrecursive**. EXE-adjacent `settings.json`,
backups, user files, and WebView data are never packaged over or deleted. Shortcut
preferences remain for later reinstall. No delete-user-data checkbox exists.

## Verification and scope

Run `node --test src-tauri/windows/template.test.mjs`. On Windows, set
`NEARLY_NSIS_ROOT` to the **existing** NSIS cache if the execution environment
redirects `LOCALAPPDATA`. The test renders a minimal compile-only fixture and
compiles both installer and uninstaller using cached NSIS/plugins. It writes
evidence to `test-results/nsis-template-compile/` and never executes the output.
The fixture payload is deliberately not a working app; its generated setup is
named `DO-NOT-RUN` and must not be distributed as the application installer.

Tests interpret the actual NSIS ownership/shortcut decision functions using only
generated registry and filesystem facts. Static tests check independent choice persistence paths, running-app guards,
write-probe order, user-data preservation, and the exact generated uninstaller
path. Actual installation, shortcut/registry modification, runtime-block UI,
upgrade behavior, and uninstall have not been executed on this host. Validate
those interactions in a disposable Windows test environment before claiming
end-to-end installer verification. Signing and automatic update installation
remain a separate release configuration task.

## Upstream provenance

Derived under the MIT license from the pinned Tauri CLI `tauri-cli-v2.12.3`
[`installer.nsi`](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)
and [`utils.nsh`](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/bundle/windows/nsis/utils.nsh).
Read-only reference copies and the upstream MIT notice are retained in
`upstream/`; none of those reference scripts is included or executed by the custom
template. In particular, the upstream running-app kill and recursive data-removal
macros are not used.

SHA-256 of the retained upstream files:

| File | SHA-256 |
| --- | --- |
| `installer.nsi` | `8AE02C66F8ADB4A0D15D97F984FBACD2B44262D8A4D03FEFAF6177F67F7008E5` |
| `utils.nsh` | `78272BD40B8A783C0AB94E4BCB400FD947BA306A7575F2BBBBCCB7478F40447F` |
| `LICENSE-MIT` | `9DD42EA92CFF2EDE5CD477CBFCCE051B2D0115C0AC7F368EE88CB545055DFF1D` |
