# Lifecycle QA evidence and remaining manual cases

Build the isolated executable with identifier `local.syncfiles.native.lifecycleqa`, native capabilities/global Tauri API matching the prior QA build, and the current lifecycle frontend/native sources. Supply its exact absolute executable path and SHA-256. The runner refuses a mismatched identifier/hash and owns its executable copy, config, WebView profile, localhost SFTP endpoint/key/pin, CDP port and result directory. Never use production executables, user settings, credentials or real servers.

```powershell
$env:NEARLY_QA_IDENTIFIER = 'local.syncfiles.native.lifecycleqa'
$env:NEARLY_QA_EXE = 'ABSOLUTE_PATH_TO_NEW_QA_EXE'
$env:NEARLY_QA_SHA256 = 'SHA256_OF_THAT_EXACT_EXE'
node scripts/native-lifecycle-test.mjs
```

Inspect `test-results/native-lifecycle-*/result.json` and its screenshots. The runner checks actual sequential/concurrent extra EXE invocations, one blank window per invocation, fresh initial blank workspace with no stopped/resume/restore controls despite legacy metadata, no automatic authentication/start/retained adoption, sole idle tab close affecting only its window, running-sync window close showing notice without job stop, a sole running tab close preserving its job, real generated SFTP upload after unrelated last-tab close, explicit stop and compact `.stopped-context`, original-main closure, later launch without `main`, final idle tab closing the final window/process/CDP listener, fixture cleanup and preservation of pre-existing Nearly processes. It also calls the real native drag begin IPC without an OS left button and verifies rejection without a transfer or source close.

## Exact unverified boundary

There is no callable `begin_workspace_transfer` IPC. `begin_tab_drag` deliberately requires the physical OS left button. No approved physical-input tool is exposed in this environment; CUA native input is disabled. No QA-only transfer entrypoint, pointer-injection helper or shim is introduced. CDP application buttons/IPC are used only for owned application lifecycle checks. A failed begin-input guard is not a failed pending-transfer rollback test. Therefore these actual native gesture cases remain UNVERIFIED by this runner; retain the native Rust protocol tests and browser mock tests as separately labelled supporting evidence:

1. With a real running generated SFTP job in the source window's sole tab, physically drag the tab into an existing target. Before target readiness, source must remain alive and own the job. After commit, source must close, target must own the same job ID/session/roots/options once, and newly written generated files must arrive remotely without reauthentication or restart.
2. Repeat by detaching the source's sole tab into a new window. Verify target visibility/readiness precedes source close, and final target job remains active. When target is the final window, a close request must show the blocked-close notice without stopping the job; stop explicitly, then close its last tab and confirm process exit.
3. Begin a physical transfer and force target failure/cancellation before readiness (Escape, target close or renderer load failure). Source must remain open with its sole tab, exact job/session identity and live file writes; no target owner or orphan preview may remain. Record the aborted transfer phase/token where available.
4. Repeat the successful and failed transfers with disconnected retained contexts, and after original `main` has closed. Repeat across mixed-DPI monitors and negative desktop coordinates, verifying drop placement and no empty orphan source window.

For every manual case record executable hash, monitor/scaling arrangement, window labels, transfer token/phase, workspace/job IDs, SSH authentication counts, before/after screenshots and received file bytes. Mark PASS/FAIL/UNVERIFIED. Do not describe direct IPC/backend evidence as physical drag evidence.
