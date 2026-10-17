/** Change only density; never replace rows, alter selection, or expand a tree. */
export function applyExplorerDensity(compact: boolean): void {
  const root = document.documentElement;
  if ((root.dataset.compactExplorer === "true") === compact) return;
  const snapshots = Array.from(document.querySelectorAll<HTMLElement>(
    ".table-scroll, .folder-tree, #connection-tree, .bookmark-tree-menu",
  )).map(scroller => {
    const viewport = scroller.getBoundingClientRect();
    const header = scroller.matches(".table-scroll")
      ? scroller.querySelector<HTMLElement>("thead") : null;
    const inset = header?.getBoundingClientRect().height ?? 0;
    const contentTop = viewport.top + inset;
    const rows = scroller.querySelectorAll<HTMLElement>(
      scroller.matches(".table-scroll")
        ? "tbody > tr[data-entry], tbody > tr.parent-row"
        : scroller.matches(".folder-tree") ? "[data-tree-row]"
        : scroller.matches("#connection-tree") ? ".connection-node-row"
        : ".bookmark-tree-item",
    );
    const anchor = Array.from(rows).find(row => {
      const rect = row.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > contentTop && rect.top < viewport.bottom;
    });
    return { scroller, header, anchor, top: scroller.scrollTop, left: scroller.scrollLeft,
      offset: anchor ? anchor.getBoundingClientRect().top - contentTop : 0 };
  });
  if (compact) root.dataset.compactExplorer = "true";
  else delete root.dataset.compactExplorer;
  for (const { scroller, header, anchor, top, left, offset } of snapshots) {
    if (!scroller.isConnected) continue;
    const newTop = scroller.getBoundingClientRect().top + (header?.getBoundingClientRect().height ?? 0);
    // A partially clipped row can become shorter than its previous clipping.
    // Retain at least one pixel of that same entry instead of skipping it.
    const anchorRect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
    const visibleOffset = anchorRect ? Math.max(offset, 1 - anchorRect.height) : offset;
    const wanted = anchorRect
      ? scroller.scrollTop + anchorRect.top - newTop - visibleOffset : top;
    scroller.scrollTop = Math.max(0, Math.min(wanted, scroller.scrollHeight - scroller.clientHeight));
    scroller.scrollLeft = left;
  }
}
