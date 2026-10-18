/** A bounded, per-session listing cache. It never stores credentials. */
export class DirectoryCache<T> {
  private values = new Map<string, { entries: T[]; expires: number }>();
  private pending = new Map<string, Promise<T[]>>();
  private epoch = 0;
  private count = 0;
  constructor(private ttl = 10_000, private maxPaths = 24, private maxEntries = 20_000, private now = () => Date.now()) {}
  invalidate() {
    this.epoch++;
    this.values.clear(); this.pending.clear(); this.count = 0;
  }
  invalidatePath(path: string) {
    // Remove pending identity too so an older response cannot repopulate this key.
    const old=this.values.get(path);if(old)this.count-=old.entries.length;
    this.values.delete(path);this.pending.delete(path);
  }
  /** Evict matching saved and pending keys without disturbing unrelated reads. */
  invalidateMatching(matches: (path: string) => boolean) {
    for (const path of new Set([...this.values.keys(), ...this.pending.keys()]))
      if (matches(path)) this.invalidatePath(path);
  }
  seed(path: string, entries: T[]) {
    const old = this.values.get(path);
    if (old) { this.count -= old.entries.length; this.values.delete(path); }
    if (this.ttl <= 0 || entries.length > this.maxEntries) return;
    this.values.set(path, { entries: [...entries], expires: this.now() + this.ttl });
    this.count += entries.length;
    while (this.values.size > this.maxPaths || this.count > this.maxEntries) {
      const key = this.values.keys().next().value!;
      this.count -= this.values.get(key)!.entries.length; this.values.delete(key);
    }
  }
  async read(path: string, load: () => Promise<T[]>, current: () => boolean = () => true): Promise<T[]> {
    const saved = this.values.get(path);
    if (saved && saved.expires > this.now()) {
      this.values.delete(path); this.values.set(path, saved);
      return [...saved.entries];
    }
    if (saved) { this.count -= saved.entries.length; this.values.delete(path); }
    const shared = this.pending.get(path);
    if (shared) return [...await shared];
    const epoch = this.epoch;
    const request = Promise.resolve().then(load);
    this.pending.set(path, request);
    try {
      const entries = await request;
      if (epoch === this.epoch && this.pending.get(path) === request && current()) this.seed(path, entries);
      return [...entries];
    } finally {
      if (this.pending.get(path) === request) this.pending.delete(path);
    }
  }
}
