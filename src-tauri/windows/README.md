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
guards reject them. A fresh interactive install can select a dedicated local
folder, defaulting to `%LOCALAPPDATA%\Nearly`. An existing owned registration fixes
the destination for reinstall/update; `/D=` cannot relocate it.
A create-new, delete-on-close write probe must succeed before payload extraction.
There is no administrator mode or runtime bootstrapper.
Existing target EXE/uninstaller files require a matching owned uninstall
registration and exact installation location before any overwrite. A settings-only
default folder containing only recognized Nearly data is a valid reinstall target.
Fresh custom folders must be empty/absent with an existing parent. Local fixed-drive
path syntax, the entire directory chain, read-only security descriptors and payload
file types are checked. Reparse points, shared-write folders and uncertain states
are refused for installation/uninstallation. Pinned ancestor handles exclude delete
sharing through mutation; no ACL is repaired or weakened. Existing default r3.0
registration remains supported. This local candidate has not been published.

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
`<registered-install-directory>\uninstall.exe`. The uninstaller validates its per-user
registered location and owned registry marker, refuses a running app, removes only the known
main EXE, its own uninstaller, target-matching shortcuts, and its own uninstall
registration. Directory removal is **nonrecursive**. EXE-adjacent `settings.json`,
backups, user files, and WebView data are never packaged over or deleted. Shortcut
preferences remain for later reinstall. No delete-user-data checkbox exists.

The uninstaller also compares the actual executing module against the existing
registered `uninstall.exe`, using complete bounded reads from regular single-link
files held against writes/deletion. This rejects stale/modified copies even with
NSIS's `_?=` directory override. NSIS's normal temporary copy and an identical
byte-for-byte copy remain equivalent; the check does not prove original launch
path. The registered image handle is released immediately before intentional
self-deletion, while directory guards remain held.

## Verification and scope

Run `node --test src-tauri/windows/template.test.mjs`. On Windows, set
`NEARLY_NSIS_ROOT` to the **existing** NSIS cache if the execution environment
redirects `LOCALAPPDATA`. The test renders a minimal compile-only fixture and
compiles both installer and uninstaller using cached NSIS/plugins. It writes
evidence to `test-results/nsis-template-compile/` and never executes the output.
The fixture payload is deliberately not a working app; its generated setup is
named `DO-NOT-RUN` and must not be distributed as the application installer.

With `NEARLY_NSIS_ROOT` pointing to the existing compiler, set
`NEARLY_NSIS_READONLY_QA=1` and run `npm run test:installer` to also execute the
minimal `READONLY-ROOT-TEST.exe` unit harnesses. They contain no application
payload, setup/uninstall section, registry writes, shortcuts or permission
changes. They exercise actual System-plugin calls for path pins, synthetic
in-memory ACLs and equal/different/missing uninstaller image reads. These unit
processes do not qualify the actual setup pages or an installation lifecycle.

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
