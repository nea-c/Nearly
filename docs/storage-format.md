# EXE-adjacent storage

Keep Nearly.exe and its five JSON documents together in a writable directory. The app does not search other directories or import older formats at startup. When all five primaries and their backups are absent, fresh startup uses defaults without writing a store merely to load it. A partial set, a missing primary with a backup present, or an unsupported, duplicate-key or inconsistent file stops loading/saving; the app never substitutes defaults for a partial store or automatically restores a backup.

| File | Contents |
| --- | --- |
| settings.json | Appearance, window position/size/maximized state, columns, sorting and the four-part commit manifest |
| history.json | Remote/local mappings, last browse locations, folder-pair and per-side folder histories |
| bookmarks.json | Separate local, remote and pair sections with independent bookmark trees |
| sync-profiles.json | Exclusions, sync options, presets and dormant retained contexts |
| connections.json | Named profiles, selection, connection tree and authoritative host-key pins |

All documents use schemaVersion 1, a distinct kind and a revision. settings.json has the global revision and exact SHA-256/revision references to the other four primaries. Unchanged parts retain their bytes and revision. IDs, connection keys and pins are preserved. Each file allows an uninterpreted metadata object, which saves retain; unsupported fields elsewhere are refused rather than silently removed. Authentication secrets are absent from the model.

## Save and recovery

The native settings mutex and existing per-window merge/CAS semantics remain. An exclusive transient `.nearly-settings.lock` coordinates cooperating process writers. Before publishing, the writer checks the exact bytes read earlier, stages and flushes all changed files and their old-byte backups, then publishes backups, changed parts and finally settings.json. This is **not a five-file atomic transaction**. Arbitrary external writers that ignore the lock can still race the final replacements.

Each `*.backup.json` contains the corresponding primary before its most recent change. A settings.backup.json manifest identifies one coherent preceding commit: for each part select the primary or backup whose exact SHA-256 and revision match that manifest. The four backups alone may be from different revisions. Never mix files merely because their timestamps look similar. An interrupted part publication is detected by manifest mismatch, including during first save; no automatic repair occurs.

For manual recovery, stop every Nearly process first, copy **all** current primaries, backups and any stale lock to a separate recovery directory, and verify that copy. Construct and validate the complete manifest-matching five-file set outside the live directory. Only then replace the live set while the app remains stopped. Do not delete a stale lock until its writer is confirmed stopped. If no full matching set exists, retain the evidence and restore a known complete external backup. Never reset connections/trust to work around an error.

## External one-time conversion

The production executable contains no converter. `scripts/storage-once.mjs` is an explicitly invoked maintenance tool; its native validator is a separately built test executable and its ignored `unified_settings::tests::external_split_fixture` entrypoint. Normal startup does not call either.

The `prepare` command requires an exact live directory, a new backup workspace **outside** it, the reviewed candidate EXE, and the exact validator EXE/hash. It refuses running Nearly processes, writer locks and existing split destinations; copies and verifies the original settings, old backup and EXE first; prepares five files through the full native semantic validator; verifies the roundtrip; then rechecks app closure and original hashes. It returns a plan path and hash without changing live files. Unknown/invalid source fields fail validation unchanged. No credential/key-file content or server is accessed.

`apply <plan-path> <reviewed-plan-sha256>` rechecks closure, source/destination hashes, candidate, prepared files and original backups; acquires the writer lock; stages and flushes every output; publishes four parts and per-file backup copies, settings.json, then the matching EXE. Before each replacement, it writes and flushes a pending-target record with before/after hashes in `apply-result.json`. Completed replacements move into its published list. After interruption, a pending target may already have been replaced: compare its actual hash with those recorded values, and never assume an unlisted target was untouched. The original complete set remains in `legacy/`. Interrupted/failed application requires explicit inspection/recovery; it never automatically retries or rolls back. Keep the app stopped throughout application. Do not execute prepare/apply against user settings merely to test them.

Closure checks conservatively include globally named Nearly copies and every executable image in the live settings directory, including renamed copies, using read-only [Restart Manager resource enumeration](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist). Query errors stop maintenance. No process is terminated or restarted. A deliberately renamed copy elsewhere with a custom configuration-directory override is outside this observable image set; stop all such writers explicitly as well. The writer lock coordinates current-format writers but does not grant authority to close other applications.

Installer/update/package operations replace application artifacts only. Tests cover all five primaries and ten primary/backup sentinels; installer contract checks do not count as actual install/uninstall execution.
