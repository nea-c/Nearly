# File-operation acceleration

## Scope

Same-pane remote duplication/copy-paste and multi-item moves, plus local root moves. Upload/download transfer code and synchronization are unchanged. No installer, release, saved profile or real remote server is used by these checks.

- Same-server copy uses advertised `copy-data` in bounded 4 MiB requests. Data stays on the server.
- Without that extension, a sliding window admits up to thirty-two 32 KiB read/write transfers, at most 1 MiB of file payload in flight. Short reads are handled within their assigned ranges. Progress counts acknowledged writes only.
- A failed transfer stops further chunk admission and settles admitted siblings. An explicitly unsupported extension is cached per connection; failure or uncertain acknowledgement does not trigger a replay.
- Up to four regular files of at most 256 KiB each run together, across selected roots or within a folder. Large files and directory creation stay sequential. The complete selection therefore remains bounded to 1 MiB of relay payload and eight file handles; server-advertised handle limits lower the width. Individual results retain every acknowledged sibling success, and the UI distinguishes current-group bytes from overall completed selections.
- Copies reuse complete READDIR file metadata for inventory and validate leaf metadata before mutation. Exclusive file creation and MKDIR reject destination collisions. Existing parent paths are checked on first use in the selection, and successful transfer/close acknowledgements finish a copy without an extra source metadata probe.
- A move uses a root rename rather than walking the subtree. Remote selections share one authenticated connection. Selected paths remain reserved for the complete batch, and the cut clipboard removes only confirmed successes.

## Earlier stress-fixture measurements

Windows desktop, generated loopback SFTP server, debug Rust test executable. These are historical single-run development measurements, not end-user guarantees or a measured comparison with WinSCP. This generic safety fixture also adds a 200 ms acknowledgement delay to WRITEs of at least 32 KiB; the final comparison below disables that size-dependent test delay.

Five 128 KiB files, 15 ms delay applied to each fixture response:

| Copy strategy | Elapsed | Relative to old serial path | File-data requests |
| --- | ---: | ---: | --- |
| Preserved pre-change serial executable | 4,362 ms | 1.00x | 10 READ + 10 WRITE |
| Bounded pipeline | 3,074 ms | 1.42x | 20 READ + 20 WRITE, up to 4 reads in flight |
| Advertised server-side copy | 2,122 ms | 2.06x | 0 READ + 0 WRITE, 5 copy-data requests |

Five folder roots containing 320 files total, 5 ms fixture response delay:

| Move strategy | Elapsed | Connections | Descendant listings |
| --- | ---: | ---: | ---: |
| Reconnect per root | 4,100 ms | 5 | 0 |
| One batched connection | 893 ms | 1 | 0 |

The move comparison isolates connection reuse: both arms use the new root-only rename. It does not quantify the additional benefit of removing the historical subtree crawl. Actual throughput depends on server support, latency, file sizes, storage and encryption.

## Reproduce and validate

Generate test-only PPK inputs with `node scripts/ppk-fixtures.mjs` before compiling Rust tests. The fixture runners create uniquely named directories beneath `test-results`, bind localhost, generate their own keys and never load saved profiles.

- `npm test`
- `npx playwright test tests/ui/remote-batch-move.spec.ts tests/ui/post-r1-file-actions.spec.ts tests/ui/duplicate-destination.spec.ts tests/ui/operation-progress.spec.ts --workers=2`
- `node scripts/remote-operation-test.mjs`
- `node scripts/remote-move-test.mjs`
- `node scripts/remote-copy-pipeline-test.mjs`

`NEARLY_COPY_FILE_BYTES=1048576` selects larger copy fixtures; `NEARLY_COPY_MODES` narrows the copy scenarios. A native executable manifest can be supplied through `NEARLY_NATIVE_TEST_MANIFEST` to reuse an already compiled harness. Raw generated outputs, keys and executables stay ignored under `test-results` and are not distribution artifacts.

The recovery test `update_recovery_windows::tests::cleanup_reparse_candidate_parent_is_refused_without_touching_external_files` is explicitly excluded from this validation. No claim is made about installed-app end-to-end testing, a real SFTP server, cross-filesystem move support, or release readiness.
## Verification result (2026-11-10)

- Node suite: 560 passed, 4 skipped, 0 failed.
- Related mocked browser UI: 28 passed, including cancelled preparation and uncertain batch results.
- Final native main-unit executable: 801 passed, 91 ignored, 1 explicitly filtered out, 0 failed. The excluded recovery test was absent from both the selected test list and execution log.
- Final generated localhost fixtures: all 15 existing copy/delete/partial-result scenarios, 6 move scenarios and 6 accelerated-copy scenarios passed.
- Extra larger fixtures confirmed eight in-flight reads, short-read correctness and multiple server-side copy offsets including a partial final chunk.
- TypeScript/Vite production bundle and whitespace checks passed. No installed Nearly app, installer or release was changed.

The review found one READDIR compatibility edge (missing modification time), which was reproduced, fixed by falling back to LSTAT, and verified on the final executable.
## Metadata round-trip reduction (2026-11-10)

The final version targets ordinary file-manager operation: shared ancestors are checked once per selection, a just-read single-file source observation is reused, and copies finish on successful transfer/close acknowledgements. There is no post-copy source metadata probe. Each standalone operation starts a fresh ancestor cache, even when a connection is reused. Failed/missing paths are not cached. Newly created directories are checked before first use as parents. Delete and synchronization behavior is unchanged.

Five files under `/bench` now require **seven LSTATs** for either copy or move: one for `/`, one for `/bench`, and one for each of the five sources. The initial versions used 55 for copy and 30 for move. Directory trees and separate parents require additional observations; seven is the measured fixture count, not a universal bound.

Copies still use exclusive destination creation/MKDIR. Moves issue ordinary SFTP v3 RENAME, which must reject an existing destination. They never use overwriting POSIX rename, delete an existing destination, or fall back to copy/delete. Existing destinations and a destination created just as RENAME arrives were tested. This relies on the server implementing the standard no-overwrite behavior; noncompliant servers are not qualified by this fixture.

These operations do not provide a snapshot against concurrent edits. An external source edit during a successful copy is no longer reported by a final metadata check, and cached parent observations do not detect an external parent replacement later in the same selection. Fresh path/mtime checks did not make those races atomic or detect every same-size, same-timestamp edit either. Transport failures, failed writes, incomplete reads, cancellation, initial unsupported/symlink entries, and exclusive-create collisions remain errors.

### Fresh comparison

Same Windows host and generated localhost server; preserved pre-change executable, final executable, and installed WinSCP. Three trials per mode/application, rotating application order. All 27 runs checked destination bytes and source presence. Median operation wire spans exclude SSH setup and child-process startup:

| Operation | Nearly before | Nearly final | WinSCP | Nearly time reduction |
| --- | ---: | ---: | ---: | ---: |
| Copy without server extension | 1.382 s | 0.598 s | 0.597 s | 56.7% |
| Server-side copy-data | 1.290 s | 0.510 s | 0.733 s | 60.4% |
| Move five directory roots | 0.213 s | 0.071 s | 0.067 s | 66.5% |

Ordinary copy and move are approximately level with WinSCP here; server-side copy is faster in this fixture. The synthetic SFTP response hold is 15 ms for copy and 5 ms for moves for every packet size, not a measured network RTT. The generic fixture's extra 200 ms delay for WRITEs >=32 KiB is disabled in the isolated comparison copy: Nearly uses 32 KiB WRITEs while WinSCP uses slightly smaller packets, so leaving it enabled unfairly penalized Nearly. Earlier cross-application pipeline comparisons with that threshold are superseded. These are wire-operation timings, not GUI timings or real-server guarantees. WinSCP's ordinary-copy arm downloads all five files to isolated temporary local files, then uploads them; Nearly streams between remote handles.

WinSCP performed five source LSTATs, but that is not its total metadata traffic: its ordinary-copy arm also performed five FSTATs, and server-copy performed 16 REALPATH requests (one setup plus 15 during operations). Avoid comparing LSTAT counts as if they represented every request.

The main wire span starts at the first `/bench` request, excluding initial root/canonicalization lookups. Including initial metadata, the final Nearly/WinSCP medians are 0.615/0.615 s (ordinary copy), 0.528/0.750 s (server copy), and 0.078/0.075 s (move). Neither measure includes SSH setup or GUI work, and child-process wall times are not ranked because their preparation paths differ.

Final evidence is in `test-results/winscp-seven-uniform-20261110/`: comparison harness, rotating-order trials, request events, executable/harness/patched-fixture hashes, raw results and `summary.json`. Prior comparisons, including the intermediate 20-LSTAT version, remain untouched in their original directories.

### Focused verification

`node scripts/remote-operation-metadata-test.mjs` covers exact seven-check counts, selection-local ancestor reuse, fresh standalone operations, separate parents, first-use ancestor refusal, omitted post-copy probes, and exclusive-create collisions. The move harness adds a destination-created-at-rename race and asserts the non-overwriting request form. The copy-change fixture now verifies ordinary successful-copy behavior after an external edit, rather than requiring a post-copy metadata warning.

No installed Nearly application, installer or release was changed. All changes remain uncommitted in the existing worktree.

Final verification on the seven-check implementation:

- Native: 801 passing tests (798 parallel plus three existing shared-counter lookahead tests run serially), 92 ignored. An initial parallel run exposed interference between those existing global-counter tests; separating that group passed without changing synchronization code.
- The prohibited recovery test was absent from both final selection lists and execution logs.
- Node: 560 passed, four skipped, zero failed.
- Generated localhost fixtures: 10 metadata cases, 15 copy/delete cases, seven move cases, and six copy-strategy cases passed on the final executable.
- Corrected uniform-delay comparison: all 27 runs passed content/source-presence verification.
- Final metadata script syntax, native compilation, and whitespace checks passed. No UI, installer, installed application, release, or remote repository was changed by this follow-up.

Logs and final code/executable hashes are retained in `test-results/metadata-seven/verification-final.json`. Earlier failed test logs are retained separately rather than overwritten.

## Concurrent CLOSE and warm file-operation transport (2026-11-10)

The next iteration overlaps source/destination CLOSE acknowledgements and retains one separate file-operation connection per connected tab session. Both CLOSE replies must settle and succeed before a copy is committed. Browsing and synchronization keep their own existing transports. The operation connection is opened lazily on the first mutation, not during application/tab startup.

The cache belongs to immutable session credentials, not the editable profile ID. A request's caller-supplied profile/passphrase cannot redirect a leased operation. A session disconnect permanently seals and closes its cache, including queued work; a new session generation gets a new cache. Operations on the same tab serialize. Different tabs do not share the transport.

Any operation error, partial batch result, or admitted cancellation discards the operation connection. A known-closed idle SSH connection may be replaced before admission. Once admitted, the operation is invoked exactly once: no failed/uncertain COPY, RENAME, DELETE or creation is replayed. A disconnect not detected before admission can fail that request; the next explicitly requested operation establishes a new connection. Acknowledged successes and partial per-item results are preserved if cancellation arrives at completion. Path/ancestor observations still start fresh for every selection. No-session direct operations retain their original connect-per-request behavior.

### Measured CLOSE overlap

Preserved pre-change seven-check executable versus final executable, three alternating trials per arm and copy strategy, five 128 KiB files. The isolated localhost fixture applies a uniform 15 ms SFTP response hold. Its generic extra 200 ms large-WRITE delay is disabled. Median operation wire spans exclude SSH setup and child-process startup:

| Strategy | Before | Concurrent CLOSE | Reduction |
| --- | ---: | ---: | ---: |
| Server-side copy-data | 496.1 ms | 415.5 ms | 16.3% |
| Relay READ/WRITE pipeline | 588.9 ms | 506.9 ms | 13.9% |

Both arms use one connection and the same request counts: seven LSTATs, ten OPENs, ten CLOSEs, plus five copy-data requests or twenty READs and twenty WRITEs. The gain comes from overlapping the two per-file close waits, not removing checks. Native operation medians including connection setup were 1171 to 1112 ms for server-copy and 1261 to 1188 ms for relay-copy; these are not GUI or process-startup timings.

### Measured warm operation reuse

A separate experiment uses the same final executable for both arms: direct reconnect-per-request versus session reuse. Three alternating paired trials each start with the same initial browse setup and execute nine file operations on generated fixtures. The first two operations are identical 128 KiB copies to different destinations. A uniform 2 ms SFTP response hold is used and the generic 200 ms large-WRITE delay is disabled. Medians:

| Measure | Reconnect each operation | Retain session operation connection |
| --- | ---: | ---: |
| First copy | 684.0 ms | 675.6 ms |
| Second identical copy | 671.0 ms | 26.8 ms |
| Sum of nine operation durations | 6.406 s | 0.913 s |
| Total connections, including browsing | 10 | 2 |

The second-copy reduction is 96.0%; the nine-operation reduction is 85.7%. The first copy still pays connection setup, and three trials do not establish a meaningful first-use difference. Timers cover the native operation function, not GUI dispatch, browse startup, fixture handshakes or process startup. The fixture uses a generated encrypted PPK v3 key with Argon2id, 8 MiB memory and three passes. Saved time combines key loading/decryption, SSH authentication and setup; it is not a universal network authentication cost. These timings use a debug executable and synthetic loopback response holds, not a WAN RTT or a real-server performance guarantee. The two experiments have different holds and must not be combined into a single percentage. WinSCP was not rerun for this iteration.

### Verification and reproduction

- Native main harness: 808 passed (805 parallel plus three existing shared-counter tests serially), 93 ignored; Windows version-resource suite: three passed.
- Node: 560 passed, four skipped, zero failed. Offline native check and compilation passed with existing warnings.
- Existing generated fixtures: ten metadata, fifteen operation, seven move and six copy-strategy cases passed.
- Four new CLOSE cases passed: overlap plus source, target and both acknowledgement failures. Both replies settle before failure reporting; no copy is committed or retried after a failed CLOSE.
- Nine warm-session cases passed: reconnect baseline, healthy single/batch copy/move/create/delete, endpoint identity isolation despite equal profile IDs and spoofed caller credentials, fresh ancestor refusal, partial-batch invalidation, cancellation, intentional disconnect/new generation, stale idle connection replacement, and a rename committed with its acknowledgement lost. The uncertain rename was sent exactly once.
- Seven transport unit tests cover serialization, setup failure without retry, known-closed replacement, partial/error invalidation, cancelled queue/setup/operation and permanent sealing.
- The prohibited recovery test was absent from both selected test lists and both execution logs. No installed application, installer, release, remote repository, or saved profile was changed. Changes remain uncommitted alongside the earlier work.

Use the generated native executable manifest with `node scripts/remote-copy-close-test.mjs` and `node scripts/warm-operation-test.mjs`. Ordinary safety fixtures retain their historical large-WRITE delay. The measurement copies explicitly disable it and are preserved under `test-results/warm-close-20261110/close-benchmark/` and `test-results/warm-close-20261110/warm-benchmark/`, with methods, raw trial values, content checks and hashes. Full test/exclusion evidence and final source/executable hashes are in `test-results/warm-close-20261110/verification-final.json`. The before-source snapshots and preserved baseline executable remain available; no reset or commit was performed.


## Bounded file groups and large-copy windows (2026-11-11)

The before arm is the preserved warm-connection/concurrent-CLOSE implementation, not the original serial implementation. Both arms use the same generated localhost fixture and debug test harness. There are three alternating trials per size and copy strategy. The fixture applies a uniform 15 ms SFTP response hold and disables its generic 200 ms large-WRITE delay. Timing spans the first operation LSTAT through the last matched response, excluding key decryption, authentication, connection setup, process startup and GUI dispatch. The table shows median elapsed wire time, not a measured WAN RTT or bandwidth.

| Selection | Strategy | Before | After | Time reduction | Speedup |
| --- | --- | ---: | ---: | ---: | ---: |
| 5 × 128 KiB | Relay | 536.9 ms | 283.1 ms | 47.3% | 1.90× |
| 5 × 128 KiB | Server copy | 443.2 ms | 244.3 ms | 44.9% | 1.81× |
| 5 × 8 MiB | Relay | 6259.1 ms | 1997.0 ms | 68.1% | 3.13× |
| 5 × 8 MiB | Server copy | 1022.4 ms | 541.1 ms | 47.1% | 1.89× |

Small files overlap in groups of at most four, with current-group bytes shown separately from confirmed completed selections. Both arms still use seven LSTATs, ten OPENs and ten CLOSEs for each five-file selection; no new pre-copy metadata round trip was retained. The large relay case replaces an eight-chunk barrier with thirty-two sliding slots, retaining the 32 KiB request size. The large server-copy case reduces copy-data requests from forty to ten by changing 1 MiB chunks to 4 MiB chunks. The aggregate relay payload bound is 1 MiB, including four concurrent 256 KiB small files; protocol framing/encoding and other process memory are additional. A file above 256 KiB is copied alone.

The server's advertised file-handle limit lowers group width. Failed limits negotiation uses one file; an explicit handle limit below two refuses copying before OPEN. Unsupported copy-data may have up to four already admitted probes in a small-file group, after which it is cached for the connection. Only an explicit unsupported first chunk permits relay fallback. Failure, lost acknowledgement, timeout, or unsupported responses after acknowledged server-copy data never cause a replay.

All admitted selected siblings retain separate ordered results. Failure/cancellation stops the next group; already acknowledged sibling successes remain successful. Cancellation drains issued transfer and CLOSE requests. The existing 15-second timeout is per request rather than a total cancellation deadline, and cleanup can add a further wait. Four-MiB server chunks also make progress/cancellation coarser and can time out on a very slow server-side storage backend; this tradeoff has not been qualified on real servers.

Verification of the final source:

- Native main harness: 814 passed plus three shared-counter tests serially; 94 ignored. Windows version resources: three passed.
- Node: 560 passed, four skipped. Focused browser progress/transfer/move suite: 33 passed. Frontend build and offline native compilation passed.
- Twenty new generated-fixture checks cover failed/cancelled siblings, folders, empty files, exact 256 KiB threshold, advertised handle caps, unavailable limits, short reads, explicit unsupported copy-data, large relay midstream failure/cancellation, and server-copy late unsupported/cancellation. Each fixture drains requests and closes handles.
- All 51 existing generated protocol checks pass: six copy-strategy, four CLOSE, fifteen operation, ten metadata, seven move and nine warm-session cases.
- Every one of the 24 timed runs verified copied contents, one connection, zero outstanding requests and zero open handles at completion.
- The prohibited recovery test was excluded explicitly and verified absent from both final selected-test lists and execution logs. No real remote endpoint, saved profile, installer, release or installed application was changed. Existing uncommitted work remains preserved.

Reproduce with the native executable manifest and scripts/remote-copy-parallel-test.mjs (NEARLY_PARALLEL_SUITE=safety,large-safety,boundary,benchmark). The benchmark requires the separately preserved before executable; it never falls back to a Cargo build. Raw timings, wire events, content checks, binary hashes, source snapshots, and the final verification record are under test-results/parallel-copy-20261111/. benchmark-summary.json records all three samples and medians. These results should not be combined with earlier experiments that used different fixture delays, and no new WinSCP comparison was run.
