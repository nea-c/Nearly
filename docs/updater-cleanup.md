# Protocol 3 update artifact cleanup

Cleanup runs after authenticated update success, fresh native settings/UI health,
and exact supervisor zero exit. Its health snapshot must be dropped first: it
pins the helper and installer without delete sharing. Cleanup errors produce a
separate nonfatal notice and never undo durable update success.

Ordinary startup retries cleanup after fresh settings/UI readiness. It authenticates
the registered installation root, signed installer, current payload identity/hash
and version, uninstaller identity and registration tuple. It checks the original
parent/helper/worker process creation identities. A missing PID or a reused PID
proves only that the original process is not live; it does not fabricate zero
exit evidence or authorize rollback. Denied or uncertain observations preserve
artifacts. Persisted records alone never authorize deletion.

Only fixed paths from that transaction are considered: its previous images,
displaced old images, residual candidate images and finally its installer.
The file's native identity, size, SHA256, single link and default data stream
must match. Root/parent directories are pinned against replacement, reparse
points are rejected, and the same verified handle performs deletion. Durable
intent precedes deletion; confirmed absence precedes progress completion.
Missing files after a recorded deletion intent can resume. Once the final setup
is missing, that branch can only finish the journal, never delete another file.

Incomplete, failed, restored or uncertain updates retain their recovery files.
Unknown files, other transactions, and empty directories without recorded native
ownership IDs are retained. There is no prefix sweep or recursive deletion.
The optional cleanup progress field defaults to absent for existing v3 records.
The new runtime adds progress/diagnostics only after durable success; deletion
waits for the peer checks. A delayed old helper may still be alive when a later
startup records a diagnostic. Its success path no longer reads the record after
publishing success, so the new optional field does not enter its recovery loop.

## Future updates must remain possible

Blocking all future updates on cleanup failure would make a locked installer or
changed artifact a permanent update barrier. Instead, before reusing the current
transaction slot, preparation preserves its exact proof/progress in an immutable
root-bound DPAPI receipt inside that transaction directory. The receipt name
includes its publication counter. Exclusive lease, exclusive creation, durable
rename without replacement, and decrypted readback are required before reuse.
An uncertain/foreign receipt prevents proof loss, rather than being overwritten.

Receipts are not discovered or replayed as deletion authority. The current
transaction is retried at later starts; after another version supersedes it,
older retained files are not automatically reclaimed. Their ownership proofs
remain available. Previously orphaned directories whose records were already
overwritten by older versions cannot be safely recovered by this change.

## Validation scope

Generated-only native fixtures cover signatures, payload/registration mismatch,
peer liveness and nonzero exit, journal interruptions, locks/retry, same-handle
cleanup, tampering/hardlinks, a real directory junction, unknown files, another
transaction, exclusive leases, old record decoding, final-setup absence, immutable
archiving and a next transaction while the old setup is locked. DOM tests cover
the separate nonfatal cleanup notice. No installed app, real update/installer,
user leftovers or user server is executed or modified by these tests.
