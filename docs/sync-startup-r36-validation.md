# r3.6 startup and post-inventory validation

The production changes combine bounded directory inventory, listing-based candidate selection, direct inventory guards, and post-inventory hint/ready-work scheduling. Trial labels and automatic-update disabling are not included.

## Observation contract

The root is checked initially with its full ancestor chain. During inventory, each directory checks its own type, permissions and canonical path before/after listing and inherits its already observed parent chain. Children depend on successful parent completion. Inventory does not continuously recheck every ancestor or detect all temporary ancestor changes.

Listing hints only select transfer candidates. Separate typed baselines are published after a complete inventory, with fixed root, scope and exclusions. Before actual upload/delete/mkdir/rename, fresh boundary/ancestor/link/permission guards remain. Deletion also checks expected metadata and local absence; incomplete inventory, mismatch, cancellation or error cannot authorize deletion. Reconnect invalidates old hints/baselines and requests manual full restart when required.

Staged hints retain the original high-precision local source observation across a fresh comparison batch. A same-protocol-second save becomes a typed source change; already observed changes remain sticky. Fresh batch failure/cancellation discards staged skip results. A single fresh file uses the existing serial path; the entire queue is not atomic. Attributes fully restored between observations remain a detection limit.

After successful upload/delete, eligible queued work causes yield instead of a fixed100ms delay. The next loop checks stop/error/events, debounce and parent dependencies. Source500ms debounce, backoff and idle/blocked waits remain. Existing per-file priority is unchanged.

## Isolated performance evidence

411 files,186 directories, root depth8, relative-depth sum921;8192bytes/file. All recorded SFTP requests have2ms extra delay, no bandwidth throttle. Actual worker, two trials per case/version, alternating order, HashMap order unspecified. Fixture creation is excluded; authentication is included. No real server or user key is used.

| Changed files | Direct inventory before postscan: mean total | Postscan: mean total | Requests before/after | Fresh comparisons before/after | Unnecessary fresh skips before/after |
|---|---:|---:|---:|---:|---:|
| 8 | 8.817s | 7.056s | 3053 / 2343 | 36 / 10 | 20 / 0 |
| 41 | 26.240s | 18.014s | 9049 / 5883 | 173 / 59 | 91 / 0 |

Post-inventory means:6.053→4.243s and23.496→15.181s. Actual100ms sleep totals:1.304→0.501s and4.614→0.502s; idle waits remain. All four postscan runs had zero upload-associated sleeps. First WRITE means were3.754→3.625s and3.612→3.586s (approximate1ms wire timestamps).

All eight runs matched all final contents and exact transferred bytes (65536/335872), with errors0, pending wire requests0 and max simultaneous requests4. Fresh full mutation guards remained2 per upload; checked directories3 per upload plus the connection check. These are one-WRITE small-file fixtures and do not characterize large-file bandwidth or guarantee real-server speed. The reported32→50s cause was not reproduced or diagnosed by this evidence.

## Regression coverage and limits

Generated localhost worker suites cover initial/later deletion and empty parents, excludes and unsupported paths, fixed deletion baselines, missing parent receipts, source-save/debounced latest content, another file progressing during repeated saves, reconnect invalidation, incomplete walks, permission/disconnect errors and cancellation barriers. A dedicated fresh2+hint1 case checks same-second save, dirty resend, final content, own.part absence, cancellation error0 and zero mutation requests after fresh comparison failure/cancellation.

Run the generic commands in sync-startup-inventory.md. The signed release workflow runs all four worker scripts, regular Rust/Node/installer tests, and browser/production UI checks. Explicit manual/fixture-only ignored tests remain distinct from passed tests; the targeted worker suite has32 cases. There is no dedicated OS scheduler fairness/stop-latency benchmark or exhaustive race proof. Normal application execution, real-server synchronization and user-setting manipulation are outside this isolated validation.

The known report of failure to start after automatic updating remains unresolved. Updater runtime/recovery source is unchanged by this release; this performance work is not a repair of that issue.
