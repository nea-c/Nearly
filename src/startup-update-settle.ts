/** A rejected write must reject settlement; a changed queue requires another attempt. */
export async function settleUpdateWrites(
  queues: () => readonly [Promise<void>, Promise<void>],
  ready: () => boolean,
): Promise<boolean> {
  const [settings, retained] = queues();
  await Promise.all([settings, retained]);
  const [latestSettings, latestRetained] = queues();
  return settings === latestSettings && retained === latestRetained && ready();
}

/** Restore each root's own prior value, including roots already locked by another flow. */
export function freezeUpdateRoots(roots: readonly { inert: boolean }[]): () => void {
  const previous = roots.map(root => [root, root.inert] as const);
  for (const [root] of previous) root.inert = true;
  return () => { for (const [root, inert] of previous) root.inert = inert; };
}
