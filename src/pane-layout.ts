import type { Store, Side } from "./core.js";

export function applyTreeRatios(store: Store) {
  for (const side of ["local", "remote"] as const) {
    const body = document.querySelector<HTMLElement>(`[data-pane=${side}] .pane-body`);
    if (!body || !Number.isFinite(body.clientWidth) || body.clientWidth <= 6) continue;
    const key = `${side}TreeWidth` as const;
    // Legacy ratios seed an intended pixel width exactly once, before any
    // center resize. Temporary constraints never overwrite that intention.
    if (!validWidth(store[key]))
      store[key] = Math.max(100, Math.min(4096, (body.clientWidth - 6) * preferredRatio(store[`${side}TreeRatio`])));
    applyTreeWidth(side, store[key]!);
  }
}
const validWidth = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 100 && value <= 4096;
const preferredRatio = (ratio: number) => Number.isFinite(ratio) ? Math.max(.15, Math.min(.65, ratio)) : .28;

export function applyTreeWidth(side: Side, desired: number) {
  const body = document.querySelector<HTMLElement>(`[data-pane=${side}] .pane-body`);
  if (!body || !Number.isFinite(body.clientWidth) || body.clientWidth <= 6) return desired;
  if (body.dataset?.treeHidden === 'true') {
    body.style.gridTemplateColumns = 'minmax(0, 1fr)';
    return desired;
  }
  const available = body.clientWidth - 6;
  const max = Math.max(0, available - 140), min = Math.min(100, max);
  const actual = Math.max(min, Math.min(max, validWidth(desired) ? desired : 100));
  body.style.gridTemplateColumns = `${actual}px 6px minmax(0, 1fr)`;
  const handle = document.querySelector(`#${side}-tree-splitter`);
  handle?.setAttribute('aria-valuenow', String(Math.round(actual / available * 100)));
  handle?.setAttribute('aria-valuemin', String(Math.round(min / available * 100)));
  handle?.setAttribute('aria-valuemax', String(Math.round(max / available * 100)));
  return actual;
}
export function applyTreeRatio(side: Side, ratio: number) {
  const preferred = preferredRatio(ratio);
  const body = document.querySelector<HTMLElement>(
    `[data-pane=${side}] .pane-body`,
  );
  if (!body || !Number.isFinite(body.clientWidth) || body.clientWidth <= 6)
    return preferred;
  const available = body.clientWidth - 6;
  return applyTreeWidth(side, Math.max(100, Math.min(4096, available * preferred))) / available;
}
export function bindTreeSplitters(
  store: Store,
  persist: () => Promise<void>,
  canStart: () => boolean,
  setDragging: (value: boolean, cancel?: () => void) => void,
  report: (error: unknown) => void,
) {
  applyTreeRatios(store);
  for (const side of ["local", "remote"] as const) {
    const handle = document.querySelector<HTMLElement>(
      `#${side}-tree-splitter`,
    );
    if (!handle) continue;
    const key = `${side}TreeRatio` as const;
    const widthKey = `${side}TreeWidth` as const;
    const save = () => void persist().catch(report);
    handle.onpointerdown = (event) => {
      if (event.button !== 0 || !canStart()) return;
      const initial = handle.parentElement?.getBoundingClientRect();
      if (
        !initial ||
        !Number.isFinite(initial.width) ||
        initial.width <= 6 ||
        !Number.isFinite(event.clientX)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const original = store[widthKey]!, originalRatio = store[key];
      let current = original,
        dragging = true;
      const finish = (commit: boolean) => {
        if (!dragging) return;
        dragging = false;
        handle.onpointermove =
          handle.onpointerup =
          handle.onpointercancel =
          handle.onlostpointercapture =
            null;
        if (handle.hasPointerCapture(event.pointerId))
          handle.releasePointerCapture(event.pointerId);
        store[widthKey] = commit ? current : original;
        store[key] = commit ? preferredRatio(current / Math.max(1, handle.parentElement!.clientWidth - 6)) : originalRatio;
        setDragging(false);
        applyTreeWidth(side, store[widthKey]!);
        if (commit) save();
      };
      setDragging(true, () => finish(false));
      handle.setPointerCapture(event.pointerId);
      handle.focus({ preventScroll: true });
      handle.onpointermove = (e) => {
        const bounds = handle.parentElement!.getBoundingClientRect();
        if (
          !Number.isFinite(bounds.width) ||
          bounds.width <= 6 ||
          !Number.isFinite(e.clientX) ||
          !Number.isFinite(bounds.left)
        )
          return;
        current = applyTreeWidth(
          side,
          Math.max(100, Math.min(4096, e.clientX - bounds.left - 3)),
        );
      };
      handle.onpointerup = () => finish(true);
      handle.onpointercancel = handle.onlostpointercapture = () =>
        finish(false);
    };
    handle.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
      if (!canStart()) return;
      const width = handle.parentElement?.clientWidth;
      if (width === undefined || !Number.isFinite(width) || width <= 6) return;
      event.preventDefault();
      const available = width - 6;
      const actual = applyTreeWidth(side, store[widthKey]!);
      store[widthKey] = Math.max(100, applyTreeWidth(
        side,
        event.key === "Home"
          ? Math.max(100, Math.min(4096, available * .28))
          : Math.max(100, Math.min(4096, actual + available * (event.key === "ArrowLeft" ? -.03 : .03))),
      ));
      store[key] = preferredRatio(store[widthKey]! / available);
      save();
    };
  }
}
