import type { Store, Side } from "./core.js";

export function applyTreeRatios(store: Store) {
  for (const side of ["local", "remote"] as const)
    applyTreeRatio(side, store[`${side}TreeRatio`]);
}
export function applyTreeRatio(side: Side, ratio: number) {
  const preferred = Number.isFinite(ratio)
    ? Math.max(0.15, Math.min(0.65, ratio))
    : 0.28;
  const body = document.querySelector<HTMLElement>(
    `[data-pane=${side}] .pane-body`,
  );
  if (!body || !Number.isFinite(body.clientWidth) || body.clientWidth <= 6)
    return preferred;
  const available = Math.max(1, body.clientWidth - 6);
  const min = Math.min(0.48, Math.max(0.15, 100 / available));
  const max = Math.max(min, Math.min(0.65, 1 - 140 / available));
  const actual = Math.max(min, Math.min(max, preferred));
  body.style.gridTemplateColumns = `minmax(0, ${actual}fr) 6px minmax(0, ${1 - actual}fr)`;
  document
    .querySelector(`#${side}-tree-splitter`)
    ?.setAttribute("aria-valuenow", String(Math.round(actual * 100)));
  return actual;
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
      const original = Number.isFinite(store[key])
        ? Math.max(0.15, Math.min(0.65, store[key]))
        : 0.28;
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
        store[key] = commit ? current : original;
        setDragging(false);
        applyTreeRatio(side, store[key]);
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
        current = applyTreeRatio(
          side,
          (e.clientX - bounds.left - 3) / Math.max(1, bounds.width - 6),
        );
      };
      handle.onpointerup = () => finish(true);
      handle.onpointercancel = handle.onlostpointercapture = () =>
        finish(false);
    };
    handle.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
      const width = handle.parentElement?.clientWidth;
      if (width === undefined || !Number.isFinite(width) || width <= 6) return;
      event.preventDefault();
      store[key] = applyTreeRatio(
        side,
        event.key === "Home"
          ? 0.28
          : (Number.isFinite(store[key]) ? store[key] : 0.28) +
              (event.key === "ArrowLeft" ? -0.03 : 0.03),
      );
      save();
    };
  }
}
