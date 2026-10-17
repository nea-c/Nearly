export type DragPoint = { x: number; y: number };
type Options<T> = {
  root: HTMLElement;
  selector: string;
  exclude?: string;
  busy: () => boolean;
  start: (source: HTMLElement, event: PointerEvent) => boolean | void;
  move: (source: HTMLElement, point: DragPoint) => T | undefined;
  drop: (source: HTMLElement, target: T) => void;
  cancel: () => void;
  scrollContainers?: () => HTMLElement[];
};

let activeCancel: (() => void) | undefined;
let clickPoint: DragPoint | undefined;
let clickUntil = 0;
let installed = false;
const bindings = new WeakMap<HTMLElement, () => void>();
export function pointerReordering() { return !!activeCancel; }
export function cancelPointerReorder() { activeCancel?.(); }

// HTML5 drag-and-drop can be intercepted by a desktop WebView host. These
// internal metadata moves use Pointer Events, including on nested popup menus.
// A normal click is left untouched until the movement threshold is crossed.
export function bindPointerReorder<T>(options: Options<T>): () => void {
  bindings.get(options.root)?.();
  if (!installed) {
    installed = true;
    document.addEventListener("pointerdown", () => { clickPoint = undefined; }, true);
    document.addEventListener("click", event => {
      if (!clickPoint || performance.now() > clickUntil || event.detail === 0 ||
          Math.hypot(event.clientX - clickPoint.x, event.clientY - clickPoint.y) > 4) return;
      clickPoint = undefined;
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
  }
  let cancelCurrent: (() => void) | undefined;
  const preventHtmlDrag = (event: DragEvent) => {
    if (event.target instanceof Element && event.target.closest(options.selector)) event.preventDefault();
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || event.isPrimary === false || options.busy() || !(event.target instanceof Element)) return;
    if (options.exclude && event.target.closest(options.exclude)) return;
    const source = event.target.closest<HTMLElement>(options.selector);
    if (!source || !options.root.contains(source)) return;
    activeCancel?.(); cancelCurrent?.();
    const origin = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    let point = origin, started = false, finished = false, frame = 0;
    let target: T | undefined;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("keydown", key, true);
      source.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("blur", cancel);
      try { if (source.hasPointerCapture(pointerId)) source.releasePointerCapture(pointerId); } catch { /* detached */ }
      source.classList.remove("pointer-reorder-source");
      document.documentElement.classList.remove("pointer-reordering");
      if (activeCancel === cancel) activeCancel = undefined;
      cancelCurrent = undefined;
      if (started) options.cancel();
    };
    const cancel = () => {
      if (started) { clickPoint = point; clickUntil = performance.now() + 500; }
      cleanup();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); cancel(); } };
    const update = () => {
      if (!source.isConnected || options.busy()) { cancel(); return; }
      target = options.move(source, point);
    };
    const tick = () => {
      if (finished || !started) return;
      const containers = (options.scrollContainers?.() ?? []).filter(container => {
        const r = container.getBoundingClientRect();
        return container.isConnected && point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
      }).sort((a, b) => a.clientWidth * a.clientHeight - b.clientWidth * b.clientHeight);
      const container = containers[0];
      if (container) {
        const r = container.getBoundingClientRect();
        const delta = (value: number, low: number, high: number) => value < low + 24 ? -Math.min(10, (low + 24 - value) / 2) : value > high - 24 ? Math.min(10, (value - high + 24) / 2) : 0;
        const top = container.scrollTop, left = container.scrollLeft;
        if (container.scrollHeight > container.clientHeight) container.scrollTop += delta(point.y, r.top, r.bottom);
        if (container.scrollWidth > container.clientWidth) container.scrollLeft += delta(point.x, r.left, r.right);
        if (top !== container.scrollTop || left !== container.scrollLeft) update();
      }
      frame = requestAnimationFrame(tick);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId || finished) return;
      point = { x: e.clientX, y: e.clientY };
      if (!started) {
        if (Math.hypot(point.x - origin.x, point.y - origin.y) < 6) return;
        if (!source.isConnected || options.busy() || options.start(source, event) === false) { cleanup(); return; }
        started = true; activeCancel = cancel;
        source.classList.add("pointer-reorder-source");
        document.documentElement.classList.add("pointer-reordering");
        try { source.setPointerCapture(pointerId); } catch { /* document listeners remain valid */ }
        frame = requestAnimationFrame(tick);
      }
      e.preventDefault(); update();
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId || finished) return;
      if (!started) { cleanup(); return; }
      point = { x: e.clientX, y: e.clientY };
      update();
      if (finished) return;
      const accepted = target;
      clickPoint = point; clickUntil = performance.now() + 500;
      e.preventDefault();
      // Drop callbacks may rerender their entire owner. Release capture and all
      // listeners first, while retaining the document-level release click guard.
      cleanup();
      if (accepted !== undefined && !options.busy()) options.drop(source, accepted);
    };
    cancelCurrent = cancel;
    document.addEventListener("pointermove", move, { capture: true, passive: false });
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("keydown", key, true);
    source.addEventListener("lostpointercapture", cancel);
    window.addEventListener("blur", cancel);
  };
  options.root.addEventListener("dragstart", preventHtmlDrag);
  options.root.addEventListener("pointerdown", down);
  const dispose = () => {
    cancelCurrent?.();
    options.root.removeEventListener("dragstart", preventHtmlDrag);
    options.root.removeEventListener("pointerdown", down);
    if (bindings.get(options.root) === dispose) bindings.delete(options.root);
  };
  bindings.set(options.root, dispose);
  // Callers use this as gesture cancellation (Escape/blur), so keep the binding
  // usable afterward. Rebinding the same root disposes old listeners above.
  return () => cancelCurrent?.();
}
