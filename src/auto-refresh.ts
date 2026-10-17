export interface RemoteChanges {
  revision: number;
  records: { revision: number; path: string; removedDirectory?: string }[];
  truncated: boolean;
}
export function remoteDirtyPaths(changes: RemoteChanges | undefined, cursor: number, root: string): string[] {
  if (!changes || changes.revision <= cursor) return [];
  const records = changes.records.filter(r => r.revision > cursor);
  if (!records.length || records[0].revision > cursor + 1) return [root];
  return [...new Set(records.map(r => r.path))];
}
type Work = { run: () => Promise<boolean>; dirty: boolean; running: boolean; first: number; version: number; timer?: ReturnType<typeof setTimeout> };
/** Bounded trailing debounce with maximum wait and a single in-flight read per key. */
export class RefreshQueue {
  private items = new Map<string, Work>();
  private disposed = false;
  constructor(private delay = 250, private maxWait = 1000, private limit = 32) {}
  request(key: string, run: () => Promise<boolean>) {
    if (this.disposed) return;
    let work = this.items.get(key);
    if (!work) {
      if (this.items.size >= this.limit) throw Error('Automatic refresh queue limit');
      work = { run, dirty: false, running: false, first: Date.now(), version: 0 };
      this.items.set(key, work);
    }
    work.run = run;
    work.version++;
    if (!work.dirty) work.first = Date.now();
    work.dirty = true;
    this.arm(key, work);
  }
  private arm(key: string, work: Work) {
    if (work.running || this.disposed) return;
    clearTimeout(work.timer);
    work.timer = setTimeout(() => void this.flush(key, work), Math.max(0, Math.min(this.delay, this.maxWait - (Date.now() - work.first))));
  }
  private async flush(key: string, work: Work) {
    if (this.disposed || !work.dirty || this.items.get(key) !== work) return;
    work.timer = undefined; work.running = true; work.dirty = false;
    const run = work.run;
    const version = work.version;
    try { if (!await run() && this.items.get(key) === work && work.version === version) work.dirty = true; }
    catch { /* The owner reports errors; an automatic failure never loops network requests. */ }
    finally {
      work.running = false;
      if (this.disposed || this.items.get(key) !== work) return;
      if (work.dirty) { work.first = Date.now(); this.arm(key, work); }
      else this.items.delete(key);
    }
  }
  cancel(key: string) {
    const work = this.items.get(key); if (!work) return;
    clearTimeout(work.timer); work.dirty = false; work.version++;
    // Retain running work until completion, so a new request cannot overlap it.
    if (!work.running) this.items.delete(key);
    else work.run = async () => true;
  }
  forget(key: string) {
    // Closed owners never reuse their UUID. Retire their slot immediately;
    // the already-running owner's generation guard rejects any late result.
    this.cancel(key);
    this.items.delete(key);
  }
  dispose() {
    this.disposed = true;
    for (const work of this.items.values()) clearTimeout(work.timer);
    this.items.clear();
  }
}
