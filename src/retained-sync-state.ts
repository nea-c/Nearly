import type { Profile, SyncTab } from "./core.js";
import type { RetainedSync } from "./retained-sync.js";
/** A display name may change; authentication and destination identity may not. */
export function sameRetainedConnection(a: Readonly<Profile> | undefined, b: Readonly<Profile>) {
  return !!a && (["id", "host", "port", "user", "auth", "mode", "keyFile", "hostKey"] as const).every(key => (a[key] ?? "") === (b[key] ?? ""));
}
export function retainedEntryState(entry: RetainedSync, jobs: readonly SyncTab[], starting: ReadonlySet<string>) {
  if (starting.has(entry.id)) return { phase: "starting" as const, pending: entry.pendingState };
  const job = jobs.find(job => job.retainedId === entry.id && job.status !== "stopped");
  return { phase: job?.status ?? "stopped", pending: entry.pendingState };
}
