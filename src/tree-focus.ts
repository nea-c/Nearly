import type { Side } from './core.js';
import type { FolderTree } from './tree.js';

/** Match the renderer's expansion/depth rules without loading or creating nodes. */
export function renderedTreePaths(tree: FolderTree): string[] {
  const paths: string[] = [];
  const visit = (path: string, depth: number) => {
    paths.push(path);
    const node = tree.peek(path);
    if (node?.expanded && depth < 40)
      for (const child of node.children) visit(child.path, depth + 1);
  };
  visit(tree.root, 0);
  return paths;
}

/** Reveal vertically in every scroll container, preserving each horizontal offset. */
export function scrollTreeVertically(target: HTMLElement) {
  const ancestors: HTMLElement[] = [];
  for (let element = target.parentElement; element; element = element.parentElement)
    ancestors.push(element);
  const horizontal = ancestors.map(element => element.scrollLeft);
  const documentScroller = target.ownerDocument.scrollingElement;
  try {
    for (const element of ancestors) {
      if (element.clientHeight <= 0 || element.scrollHeight <= element.clientHeight) continue;
      const root = element === documentScroller;
      if (!root && !/^(auto|scroll|hidden|overlay)$/.test(getComputedStyle(element).overflowY)) continue;
      const bounds = element.getBoundingClientRect();
      const top = root ? 0 : bounds.top + element.clientTop;
      const bottom = top + element.clientHeight;
      const rect = target.getBoundingClientRect();
      // An oversized row already spanning the viewport needs no movement.
      if (rect.top < top && rect.bottom < bottom) element.scrollTop += Math.max(rect.top - top, rect.bottom - bottom);
      else if (rect.bottom > bottom && rect.top > top) element.scrollTop += Math.min(rect.bottom - bottom, rect.top - top);
    }
  } finally {
    ancestors.forEach((element, index) => { if (element.scrollLeft !== horizontal[index]) element.scrollLeft = horizontal[index]; });
  }
}

function identity(side: Side, path: string) {
  return (side === 'local' ? path.replaceAll('/', '\\').toLowerCase() : path)
    .replace(/[\\/]$/, '') || '/';
}

/** Resolve from rendered rows only: never read/load/expand a model node. */
export function visibleTreeTarget(side: Side, path: string, rendered: readonly string[]): string | undefined {
  const current = identity(side, path), separator = side === 'local' ? '\\' : '/';
  return rendered.filter(candidate => {
    const id = identity(side, candidate);
    return id === current || current.startsWith((id === '/' ? '' : id) + separator) || (side === 'local' && candidate === '@pc');
  }).sort((a, b) => (a === '@pc' ? -1 : a.length) - (b === '@pc' ? -1 : b.length)).at(-1);
}

/** Branch interaction may reveal the current path only inside that branch. */
export function treeBranchContains(side: Side, branch: string, current: string): boolean {
  return visibleTreeTarget(side, current, [branch]) === branch;
}

/** One connection-start exception: validate each ancestor before revealing the next.
 * The caller owns tab/connection/navigation/user-interaction cancellation.
 */
export async function expandConnectionTree(tree: FolderTree, current: string, load: (path: string) => Promise<number | undefined>, valid: () => boolean) {
  let path = tree.root;
  for (let depth = 0; depth < 40 && valid(); depth++) {
    if (identity(tree.side, path) === identity(tree.side, current)) return;
    const node = tree.node(path);
    node.expanded = true;
    // record(current) may synthesize edges into an already-loaded ancestor.
    // Reapply its authoritative listing (including the cached connection home)
    // before trusting child membership; ordinary tree projection stays unchanged.
    const completedRequest = await load(path);
    if (!valid() || !node.expanded) return;
    if (node.error) { node.expanded = false; return; }
    if (completedRequest === undefined || !node.loaded || node.request !== completedRequest) return;
    const child = node.children.find(child => treeBranchContains(tree.side, child.path, current));
    if (!child) return;
    path = child.path;
  }
}

export interface TreeRevealContext {
  workspace: object;
  connection: object | undefined;
  tree: object;
  side: Side;
  path: string;
}
export class TreeRevealIntent {
  private pending?: TreeRevealContext;
  private waiting?: string;
  request(context: TreeRevealContext, waiting?: string) { this.pending = { ...context }; this.waiting = waiting; }
  get waitingFor() { return this.pending ? this.waiting : undefined; }
  cancel() { this.pending = undefined; }
  consume(context: TreeRevealContext, rendered: readonly string[]) {
    const pending = this.pending;
    if (!pending) return;
    if (pending.workspace !== context.workspace || pending.connection !== context.connection ||
        pending.tree !== context.tree || pending.side !== context.side || pending.path !== context.path) {
      this.cancel(); return;
    }
    const target = visibleTreeTarget(context.side, context.path, rendered);
    if (target !== undefined) this.cancel();
    return target;
  }
  get side() { return this.pending?.side; }
}
