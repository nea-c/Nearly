# Native tab drag and repeat-launch QA

## Automated evidence scope

`scripts/native-drag-launch-test.mjs` requires a freshly built, isolated QA executable with identifier `local.syncfiles.native.dragwindowqa`. It refuses a missing identifier, missing SHA-256, or mismatched executable bytes. It copies only that executable into its own generated result directory and uses its own settings, WebView profile, free CDP port, localhost SFTP fixture, generated encrypted key and generated host pin. It must never point at a production executable, user settings, credentials, or a real server.

Run from the project root after obtaining the new executable and hash:

```powershell
$env:NEARLY_QA_IDENTIFIER = 'local.syncfiles.native.dragwindowqa'
$env:NEARLY_QA_EXE = 'ABSOLUTE_PATH_TO_ISOLATED_QA_EXE'
$env:NEARLY_QA_SHA256 = 'SHA256_OF_THAT_EXACT_EXE'
node scripts/native-drag-launch-test.mjs
```

Read `test-results/native-drag-launch-*/result.json`, not just console output. A successful run proves actual second-process invocations exit successfully while the original process creates separate usable blank native windows, including three sequential and two concurrent invocations. It checks native ownership, no retained-owner adoption, no automatic connection/authentication/job start, unchanged job IDs, shared settings merge/conflict behavior, original-main close survival, a later invocation with `main` absent, a real secondary-owned SFTP job, live upload after unrelated blank close, preserved original retained settings, generated secret non-persistence, and cleanup. CDP screenshots show owned windows. Pre-existing Nearly processes are recorded and preserved.

The runner uses WebView CDP for application buttons and scoped native IPC for backend assertions. It does **not** prove a physical tab gesture, native pointer hit testing, drop position, Windows hook delivery, or mixed-display placement. Direct transfer commands, mocked pointer events, and DOM/CDP drag sequences are not substitutes for that evidence.

## Physical-input blocker

This execution environment exposes no `node_repl`/`@oai/sky` input surface and its CUA native APIs are disabled. The computer-use skill requires its documented JavaScript API. No custom SendInput, UIA, PowerShell mouse helper, or other invented OS automation is used. Physical cross-window drag, release outside the WebView, native drag preview and mixed-DPI/multi-monitor behavior remain **unverified** until performed using an approved physical-input tool or by a human.

## Manual physical checks

Use the same isolated QA identifier and generated fixture/settings, with two windows in the same owned backend. Record the executable hash, OS version, monitor arrangement, per-monitor scale, source/target labels and tab IDs. Keep a running generated sync visible where applicable. Save before/after screenshots and its native job ID, workspace owner, SFTP connection/authentication/write counters and received test-file contents.

1. Confirm right-click tab menus no longer offer “Move to new window”. Click a tab without moving and verify normal activation. Drag within the strip to reorder; verify the insertion marker, final order and unchanged workspace/session/job identity.
2. Hold the physical left button on a disconnected retained tab and move outside the source strip. Verify a native preview follows the pointer. Release on empty desktop space: exactly one new window appears at the release position, the source loses exactly that tab and the destination owns it once. Confirm no authentication, job start or retained-context duplication.
3. Drag that tab physically over another existing window's tab strip. Verify the target insertion marker and release before the first tab, between tabs and after the last tab. Each drop must merge into the indicated position without a duplicate window, duplicate tab, or source-owned session.
4. Repeat detach and merge with a real running generated SFTP job. Record the same job ID, roots, options, retained record ID and SSH authentication count before and after. Write a new generated local file and verify it arrives remotely. Verify inactive windows cannot stop or disconnect the transferred job.
5. Drag outside the strip and return to the source before releasing; verify reorder or cancellation preserves ownership. Press Escape while holding; release afterwards and verify no late detach. Release outside every app WebView and verify the actual OS release is handled once. Repeat rapidly and confirm no orphan preview or duplicate commit.
6. Close a target during a held drag, then release. Verify rollback leaves the tab/session/job accessible in exactly one surviving window. Close the source only when its job is stopped or has actually transferred. Verify no app exit while another window remains.
7. Invoke the same QA EXE while dragging, then cancel or finish the drag. The invocation should create one blank window in the existing backend without adopting the dragged context or starting anything.
8. Repeat with 100%, 125%, 150% and 200% Windows scaling, including crossing mixed-DPI monitor boundaries in both directions. Test monitors left/above the primary (negative desktop coordinates), maximized and restored windows, target activation/occlusion, taskbar edges and near-screen-edge drops. Verify preview position, physical hit testing, insertion position and final window bounds remain correct and visible.
9. After the original `main` window closes, repeat a physical detach/merge between surviving windows and invoke the EXE again. Verify all remaining windows and the secondary job continue, then stop all owned jobs and close all owned windows. Confirm the QA process, CDP listener and fixture connections exit without affecting any pre-existing Nearly process.

Mark each item PASS/FAIL/UNVERIFIED with evidence. Do not report “native cross-window drag passed” from automated launch/backend evidence alone.

R2追加確認: 複数タブをドラッグしたままタブ列を出て、実際のファイル閲覧画面を持つ別ウインドウがボタンを離す前に現れ、ポインターに追従することを確認する。結合先へ重ねた間だけ仮ウインドウが隠れ、受け入れ先にだけ挿入位置が出ること、元のウインドウには結合位置の線が出ないことを確認する。Escape・移動先を閉じる操作・初期化失敗では元の所有権と同期が残ることを確認する。1タブでは新しい窓が増えず、元の窓を動かすこと。異なるDPIの画面間で繰り返す。これは手動確認項目であり、自動テストで合格したとは扱わない。
