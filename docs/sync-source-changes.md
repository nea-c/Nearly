# Source changes and bounded startup comparisons

Base: r3.4 `5c5ff67d0bf5fc86dd414c8d391b9a34b9e95366`. This work is separate from updater cleanup.

Normal source changes return typed successful observations, rather than errors that close the transport. Uploads observe one source snapshot (native file identity, length and precise modification time) through the original read handle and the current pathname. A change during a write batch or before commit aborts that attempt. Only its exclusively created stage is eligible for removal, after closing it and obtaining fresh parent and file attribute proofs; removal must be confirmed absent. Cleanup/lookup failures remain real errors.

The worker merges the changed item back into its queue with a 500ms debounce. It retains forced-upload state, so a same-size save within the same SFTP timestamp second cannot be skipped on the retry. Actual watcher file changes also force upload. Older watcher timestamps cannot shorten the debounce. Manual stop/failure prevents requeue. Ready forced uploads and already compared upload candidates bypass comparison preflight, allowing transfer progress while other files keep arriving.

A save after atomic rename can leave a complete older version remotely. The receipt retains its original source observation; remote proof and change journal are recorded before the latest local version is scheduled. Remote metadata errors and uncertain rename acknowledgements retain their committed/unknown classifications and stop the job. I/O, sharing, permission, network and unknown errors are not converted to normal changes.

Startup comparison preflight uses up to four independent files on the same authenticated SFTP session. Each file retains sequential ancestor verification and final canonical/path checks. All results are withheld until the complete batch succeeds, then all local observations are rechecked. Unchanged results are consumed immediately; upload candidates are compared again at their normal transfer point, without retaining stale comparison authority across uploads. No transfer/deletion runs inside the batch. A batch failure/cancellation discards results; mutation and deletion guards remain unchanged.

The vendored russh-sftp raw session supports asynchronous outstanding requests using atomic request IDs, an ID-indexed response map and one-shot receivers. Dropped requests remove their pending receiver; late replies cannot become another request's reply. No additional connection/authentication is introduced by a batch.

## Isolated evidence

Eight distinct unchanged generated files (sizes 1–8 bytes), parent depth three, 20ms synthetic delay per LSTAT, one generated localhost SFTP session. Three paired trials from `sync-followup-rust-final3.log`:

| Trial | Serial | Batch four | LSTAT per mode | REALPATH per mode |
| --- | ---: | ---: | ---: | ---: |
| 1 | 1351ms | 352ms | 64 | 8 |
| 2 | 1361ms | 350ms | 64 | 8 |
| 3 | 1365ms | 359ms | 64 | 8 |

Each mode used one TCP/authenticated session. Maximum delayed requests were one versus four. The timed region covers only file comparison calls, including their local observations and complete remote guards. Connection/authentication, initial local scan, remote inventory and actual transfer are excluded. REALPATH has no artificial delay. Separate reverse-order replies with distinct file sizes verify response/result correspondence.

This is a controlled fixture result, not a real-server speed guarantee. Directory inventory and local scanning are separate phases and are not accelerated by this comparison pipeline.

Failure/cancellation worker fixtures use identical preexisting files and wait for four outstanding comparisons before injecting their fault/stop. Earlier versions wrongly assumed every local-only upload waited for that batch: mirror inventory can debounce existing remote candidates later, allowing a legitimate earlier single upload. The corrected fixture tests the actual batch boundary and checks mutation request counts after confirmed stop.

These boundary fixtures remove their common fixture's remote-only deletion sentinel: it otherwise legitimately occupies one of the four candidate slots before local-action filtering, leaving only three files to compare. They hold comparison-phase replies for 500ms to make four outstanding server requests observable; 20ms replies can complete before a fourth request arrives. Those conditions are separate from the performance benchmark. Actual post-stop local removal/new-file events remain in the boundary tests, with unchanged WRITE/REMOVE/RMDIR/RENAME/EXTENDED counts after confirmed stop.

Node 22.11/libuv's Windows rename API returned EPERM replacing an open destination even in a minimal reader-only fixture. Native Rust replacement succeeded with the real upload read handles open, and the worker resent the replacement. The native atomic-save test uses a fixture handshake to perform that actual replacement; it does not pretend the failed Node operation succeeded. Editors using different Windows rename APIs may themselves fail to save an open destination.

## Limits

Metadata comparison remains size plus whole-second remote mtime. It does not prove content identity. Same-identity in-place edits that restore both length and precise mtime can evade source observations; no full-file startup hash was added. An atomic pathname replacement is detectable by native file identity even with equal length/mtime. Transient disappearance, sharing violations or uncertain local reads remain conservative errors rather than being assumed to be successful saves.

SFTPv3 exposes no inode/conditional unlink primitive. Fresh parent/attribute checks cannot distinguish an adversarial same-attribute replacement between LSTAT and REMOVE. The implementation retains the existing protocol safety limits and does not claim an absolute remote object identity guarantee. Cancellation or a real cleanup error can leave an owned `.part` for manual inspection; there is no prefix-based sweep.

No real user server, credentials, settings, existing EXE or installer was used. Tests exercise generated files and a disposable loopback server. Publication is not part of this work.
