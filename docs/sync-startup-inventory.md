# Initial inventory and listing comparisons

Deletion-enabled startup completes the local scan and remote inventory before
publishing any deletion baseline. Remote directories are listed in independent
batches of at most four on the existing authenticated session, sharing entry,
depth, batch and memory budgets. Failure or cancellation discards the result.
Each directory retains its before/after ancestor, type, permission and canonical
path checks. No ancestor cache or new connection pool is introduced.

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
not rebasing, stale peer-hint invalidation, a source save during observation,
reconnect invalidation and manual full restart. Pipeline tests cover failures,
cancel, invalid paths, hierarchy, shared limits and mutation stop barriers.
Fixtures generate their own disposable loopback server, keys and files under
`test-results/`; no user server or installed app is required.

Performance depends on directory depth, network and server latency. These
changes reduce redundant startup work; they do not guarantee a particular
real-server startup time or eliminate the complete inventory requirement.
