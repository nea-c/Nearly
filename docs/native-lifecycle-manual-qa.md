# Lifecycle QA evidence and remaining manual cases

Build the production-mode frontend first (`npm run build`, mock mode disabled). Then build an installer-free QA executable with `node node_modules/@tauri-apps/cli/tauri.js build --no-bundle --ci --config scripts/native-lifecycle-build.json -- --locked --offline`. That config sets identifier `local.syncfiles.native.lifecycleqa` and skips the frontend command. Immediately copy the fresh QA artifact into its own unique directory before building another identifier. Never select an older shared-target EXE as QA proof.

Supply its exact absolute path, SHA-256 and build provenance JSON. The provenance records `identifier`, `artifact`, `sha256`, `config`, `configSha256`, exact `command`, `frontendMockEnabled:false`, and `sourceHashes` entries with project-relative `path` and `sha256` for the native/frontend/config inputs and built `dist`. Retain build logs alongside it. The runner checks these before launching, then also checks the actual runtime identifier. An environment label cannot isolate a production-identifier binary. The runner owns its executable copy, config, WebView profile, localhost SFTP endpoint/key/pin, CDP port and result directory. Never use production executables, user settings, credentials or real servers.

```powershell
$env:NEARLY_QA_IDENTIFIER = 'local.syncfiles.native.lifecycleqa'
$env:NEARLY_QA_EXE = 'ABSOLUTE_PATH_TO_NEW_QA_EXE'
$env:NEARLY_QA_SHA256 = 'SHA256_OF_THAT_EXACT_EXE'
$env:NEARLY_QA_PROVENANCE = 'ABSOLUTE_PATH_TO_QA_BUILD_INFO_JSON'
node scripts/native-lifecycle-test.mjs
```

Inspect `test-results/native-lifecycle-*/result.json` and its screenshots. The runner checks actual sequential/concurrent extra EXE invocations, one blank window per invocation, fresh initial blank workspace with no stopped/resume/restore controls despite legacy metadata, no automatic authentication/start/retained adoption, sole idle tab close affecting only its window, running-sync window close showing notice without job stop, a sole running tab close preserving its job, real generated SFTP upload after unrelated last-tab close, explicit stop and compact Resume control, original-main closure, later launch without `main`, final idle tab closing the final window/process/CDP listener, fixture cleanup and preservation of pre-existing Nearly processes. It also calls the real native drag begin IPC without an OS left button and verifies rejection without a transfer or source close.

After all generated jobs stop, it creates new source/destination folders, performs an internal local-row pointer drag and recursive confirmation through real Tauri IPC, verifies exact localhost SFTP bytes and retained local sources, and checks that the operation's request slice contains no remove/rename. It then seeds only the owned settings with offscreen normal geometry while stopped, checks actual native getters, maximizes, restarts and unmaximizes using existing controls. Missing work-area/getter support leaves the dependent assertion explicitly unsupported. Main and ordinary secondary WebViews must emit the fixed getter-derived `input-policy: verified general-autofill=false password-autosave=false` stderr marker; missing/failed observation is not runtime enforcement proof. An unexpected pre-existing QA owner is reported without terminating it. Cleanup addresses captured owned process handles only.

## Exact unverified boundary

There is no callable `begin_workspace_transfer` IPC. `begin_tab_drag` deliberately requires the physical OS left button. No approved physical-input tool is exposed in this environment; CUA native input is disabled. No QA-only transfer entrypoint, pointer-injection helper or shim is introduced. CDP application buttons/IPC are used only for owned application lifecycle checks. A failed begin-input guard is not a failed pending-transfer rollback test. Therefore these actual native gesture cases remain UNVERIFIED by this runner; retain the native Rust protocol tests and browser mock tests as separately labelled supporting evidence:

1. With a real running generated SFTP job in the source window's sole tab, physically drag the tab into an existing target. Before target readiness, source must remain alive and own the job. After commit, source must close, target must own the same job ID/session/roots/options once, and newly written generated files must arrive remotely without reauthentication or restart.
2. Repeat by detaching the source's sole tab into a new window. Verify target visibility/readiness precedes source close, and final target job remains active. When target is the final window, a close request must show the blocked-close notice without stopping the job; stop explicitly, then close its last tab and confirm process exit.
3. Begin a physical transfer and force target failure/cancellation before readiness (Escape, target close or renderer load failure). Source must remain open with its sole tab, exact job/session identity and live file writes; no target owner or orphan preview may remain. Record the aborted transfer phase/token where available.
4. Repeat the successful and failed transfers with disconnected retained contexts, and after original `main` has closed. Repeat across mixed-DPI monitors and negative desktop coordinates, verifying drop placement and no empty orphan source window.

For every manual case record executable hash, monitor/scaling arrangement, window labels, transfer token/phase, workspace/job IDs, SSH authentication counts, before/after screenshots and received file bytes. Mark PASS/FAIL/UNVERIFIED. Do not describe direct IPC/backend evidence as physical drag evidence.

## Bookmark and tree refinement checks

The runner also generates 90 child folders after all jobs stop. In both languages and panes it repeats exact-current and collapsed-ancestor tree reveal 24 times, checking actual WebView focus/outline/scroll geometry and unchanged browsing/expansion state. It checks removed controls/headings, toggle placement, pointer versus keyboard overflow and keyboard context access using generated bookmarks. This remains owned WebView/CDP input, not physical OS input. The receipt-bound QA build root is derived from the copied artifact path so an unchanged prior QA can reproduce a regression without launching the production binary.
