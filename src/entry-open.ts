import type { Entry, Side } from './core.js';
import { childPath, supportedName } from './tree.js';

export async function entryOpenTarget(
  side: Side,
  parent: string,
  entry: Pick<Entry, 'name' | 'dir'>,
  resolveShortcut: (path: string) => Promise<string>,
): Promise<string | undefined> {
  if (!supportedName(entry.name)) return;
  if (entry.dir) return childPath(side, parent, entry.name);
  if (side === 'local' && /\.lnk$/i.test(entry.name))
    return resolveShortcut(childPath(side, parent, entry.name));
}
