# Initial inventory and listing comparisons

Deletion-enabled startup completes the local scan and remote inventory before
publishing any deletion baseline. Remote directories are listed in independent
batches of at most four on the existing authenticated session, sharing entry,
depth, batch and memory budgets. Failure or cancellation discards the result.
The root receives an initial full ancestor check. Each directory then checks its
own type, permission and canonical path before and after listing, inheriting the
already observed parent chain. Children are scheduled only after their parent
completes. Repeated fresh checks of every ancestor during inventory are removed;
mutation-time guards remain fresh. No new connection pool is introduced.

Complete listing attributes select initial transfer candidates. Listed unchanged
files skip fresh per-file remote comparisons; initially existing directories
receive local validation instead of another remote adoption. A local save during
comparison invalidates that observation and uses the existing debounced latest-
source upload path. Missing parent directories receive guarded creation before
their dependent file. Existing empty directories remain tracked.

Listing hints cannot authorize changes. Separate typed listing baselines retain
the complete inventory's file size/mtime and guarded parent/directory chain.
Actual deletion still requires fresh matching metadata/ancestors, canonical path
and no-link checks, local absence and cancellation checks. Directory deletion
also requires a fresh complete empty listing and nonrecursive RMDIR. Excluded,
unsupported or incompletely inventoried descendants remain protected.

An unchanged read-only comparison never updates a deletion baseline. Only an
own verified upload or successful actual directory creation establishes a new
receipt. A remote change that remains different at deletion is rejected. A change
that returns to the same observable metadata between observations is not
guaranteed detected. The listing is not an atomic remote snapshot; SFTPv3 does
not provide conditional removal across the ancestor chain. Same-size/mtime-
preserving edits and indistinguishable path replacements remain protocol limits.

Reconnect clears hints and suspends old baselines. Uploads can continue, but old
baselines cannot authorize deletion. An idle affected job shows a deletion-rescan
notice and paused taskbar state instead of caught-up. Work in progress remains
working; real errors and stop retain priority. Japanese and English guidance
directs the user to stop and start sync for a full scan. No automatic baseline
renewal, retry or restart is introduced. The notice survives workspace transfer.

## Isolated regression commands

After `npm ci`, run `node scripts/ppk-fixtures.mjs` to generate disposable,
Git-ignored test keys (the existing Windows workflows do this too). Then run
`cargo test --locked --manifest-path src-tauri/Cargo.toml`, `npm test` and
`npm run build`. Generated localhost fixtures additionally exercise the real
worker, never saved connection settings:

```
node scripts/listing-worker-test.mjs
node scripts/listing-existing-pipeline-test.mjs
node scripts/sync-difference-test.mjs
node scripts/sync-difference-test.mjs directory_deletion_generated_localhost
```

The listing suite checks later deletion and empty-parent removal, missing-parent
receipts, baseline mismatch/allowed return-to-same-metadata, read-only matches
not rebasing, valid peer-hint preservation, a source save during observation,
high-precision source revalidation across a fresh batch, failed/cancelled batches,
reconnect invalidation and manual full restart. Pipeline tests cover failures,
cancel, invalid paths, hierarchy, shared limits and mutation stop barriers.
Fixtures generate their own disposable loopback server, keys and files under
`test-results/`; no user server or installed app is required.

Performance depends on directory depth, network and server latency. These
changes reduce redundant startup work; they do not guarantee a particular
real-server startup time or eliminate the complete inventory requirement.

## Bounded independent uploads (local follow-up)

Non-deletion startup may list only the parents of initial local file candidates.
This read-only pass is bounded and consumed entirely before uploads; it is not
a persisted cache or mutation authority. Unknown READDIR attributes use fresh
per-file comparison. Unsupported/denied listing before any successful read
discards the entire pass and falls back; incomplete reads and network failures
stop rather than inventing absence. Deletion-enabled inventory is unchanged.

Positive upload candidates can share one authenticated SFTP session in bounded
same-parent batches. Directory creation and all deletion stay serial. Parent
preparation hints only avoid redundant creation attempts; every file still
checks local identity/stability, remote ancestors/type/canonical path, exclusive
staging, timestamps and the final stop/commit barrier independently. Reconnect
clears preparation hints; hints never authorize deletion. Case aliases and
overlapping destinations cannot enter a batch together.

The batch-wide WRITE window remains at most eight 32KiB requests (256KiB),
divided across active files. This bound is per sync session, not an application-
wide cap across independent jobs. No additional SSH connections are created.
Advertised OpenSSH open-handle limits reduce file concurrency before dispatch;
a rejected advertised limits query selects serial uploads. An unadvertised
resource limit is a real partial failure, not a trigger to replay writes.

Independent in-flight peers settle after a file error so acknowledged commits
are retained. Rename-issued/no-ACK outcomes remain unknown; neither unknown
nor failed writes are automatically retried. The job stops for manual restart
and a fresh comparison. Cancellation may leave exclusive staging files or
already committed targets; it never reports those as definitely unsent.
Source changes use the existing stability wait before another attempt.

SFTPv3 cannot atomically compare-and-rename across ancestor/target mutations.
Existing same-size/mtime-preserving edits and indistinguishable replacements
remain protocol limits; these checks are not an unconditional TOCTOU guarantee.

The production default is four independent files, capped further by advertised
server handles; the internal hard ceiling is eight. A test-only width override
compares1/2/4/8 without creating a persistent setting.

Single sequential samples, Windows/local disk + generated localhost SFTP,
4,000 files x512bytes (2,048,000bytes),50directories/two relative directory
levels, delete OFF, no artificial delay:

| File concurrency | Initial sync | Unchanged restart |20 changed files |
| --- | ---: | ---: | ---: |
|1 (listing-only scheduling) |61.347s |5.528s |0.905s |
|2 |59.486s |5.457s |0.801s |
|4 (default) |46.350s |5.413s |0.769s |
|8 |39.193s |5.438s |0.823s |

Four is24.4% faster than the contemporaneous serial sample while using half
the maximum open-file resources of eight. The prior separate listing-only
sample was51.808s; these are single samples, not stable throughput guarantees.
The unchanged pass performs724LSTAT/80READDIR with zero uploads in every case.
A separate16-file test with20ms artificial delay on each LSTAT (not a full
network RTT simulation) measured initial upload7.977s/4.711s/3.075s/2.262s
and deletion-enabled initial sync12.610s/6.877s/4.185s/2.769s for1/2/4/8.
No live remote or equal-workload WinSCP comparison was performed.
