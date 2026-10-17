import type { FileSelection } from "./selection.js";

export const MARQUEE_THRESHOLD = 5;
export function crossedThreshold(
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  return Math.hypot(b.x - a.x, b.y - a.y) >= MARQUEE_THRESHOLD;
}
export function intersects(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
) {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}
function hitsText(cell: Element, x: number, y: number) {
  const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  for (let text = walk.nextNode(); text; text = walk.nextNode()) {
    if (!text.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(text);
    if (
      [...range.getClientRects()].some(
        (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
      )
    )
      return true;
  }
  return false;
}
export function marqueeWhitespace(
  target: EventTarget | null,
  x: number,
  y: number,
) {
  if (!(target instanceof Element)) return false;
  if (
    target.closest(
      'thead,button,input,textarea,select,a,[contenteditable="true"],[data-no-marquee]',
    )
  )
    return false;
  if (target.closest(".folder-glyph,.document-glyph,[data-entry-icon]"))
    return false;
  const cell = target.closest("td");
  if (target.closest("[data-entry]")) return !!cell && !hitsText(cell, x, y);
  return !!target.closest("[data-list]");
}
type Options = {
  list: HTMLElement;
  rows: () => HTMLElement[];
  selection: FileSelection;
  paint: () => void;
  active: (value: boolean, cancel?: () => void) => void;
  current: () => boolean;
  render: () => void;
};
let clickGuardInstalled = false;
let suppressClickUntil = 0;
let suppressedPane: string | null = null;
let suppressedWorkspace: string | null = null;
let suppressedPoint = { x: -1, y: -1 };
export function bindMarqueeSelection(options: Options) {
  const { list, selection } = options;
  if (!clickGuardInstalled) {
    clickGuardInstalled = true;
    document.addEventListener(
      "click",
      (event) => {
        if (
          Date.now() >= suppressClickUntil ||
          !(event.target instanceof Element)
        )
          return;
        if (
          Math.abs(event.clientX - suppressedPoint.x) > 2 ||
          Math.abs(event.clientY - suppressedPoint.y) > 2
        )
          return;
        const targetList =
          event.target.closest("[data-list]") ??
          document
            .elementFromPoint(event.clientX, event.clientY)
            ?.closest("[data-list]");
        if (
          targetList?.getAttribute("data-list") !== suppressedPane ||
          targetList.getAttribute("data-workspace") !== suppressedWorkspace
        )
          return;
        suppressClickUntil = 0;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
  }
  let cancelCurrent: (() => void) | undefined;
  list.onpointerdown = (event) => {
    if (
      event.button !== 0 ||
      !options.current() ||
      !marqueeWhitespace(event.target, event.clientX, event.clientY)
    )
      return;
    cancelCurrent?.();
    const pointerId = event.pointerId;
    const origin = { x: event.clientX, y: event.clientY };
    const initial = selection.values();
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const base = additive ? initial : [];
    const downRow =
      event.target instanceof Element
        ? event.target.closest("[data-entry]")
        : null;
    const area = list.getBoundingClientRect();
    const start = {
      x: origin.x - area.left + list.scrollLeft,
      y: origin.y - area.top + list.scrollTop,
    };
    let rectangle: HTMLElement | undefined,
      done = false,
      dragged = false;
    let lastPoint = origin;
    const finish = (cancel = false) => {
      if (done) return;
      done = true;
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", abort, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("dragstart", preventNativeDrag, true);
      window.removeEventListener("blur", abort);
      list.removeEventListener("lostpointercapture", abort);
      list.removeEventListener("scroll", scroll);
      rectangle?.remove();
      if (list.hasPointerCapture(pointerId))
        list.releasePointerCapture(pointerId);
      if (cancel && dragged && options.current()) {
        selection.rectangle(initial);
        options.paint();
      }
      if (!cancel && !dragged && !downRow && !additive && options.current()) {
        selection.clear();
        options.paint();
      }
      if (dragged) {
        suppressClickUntil = Date.now() + 400;
        suppressedPane = list.getAttribute("data-list");
        suppressedWorkspace = list.getAttribute("data-workspace");
        suppressedPoint = lastPoint;
      }
      cancelCurrent = undefined;
      options.active(false);
      if (dragged && options.current()) options.render();
    };
    const abort = () => finish(true);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(true);
      }
    };
    const preventNativeDrag = (e: DragEvent) => {
      if (e.target instanceof Element && list.contains(e.target))
        e.preventDefault();
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId === pointerId) {
        lastPoint = { x: e.clientX, y: e.clientY };
        finish();
      }
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      lastPoint = { x: e.clientX, y: e.clientY };
      if (!options.current() || !list.isConnected) {
        finish(true);
        return;
      }
      if (!dragged && !crossedThreshold(origin, { x: e.clientX, y: e.clientY }))
        return;
      if (!dragged) {
        dragged = true;
        rectangle = document.createElement("div");
        rectangle.className = "selection-marquee";
        list.append(rectangle);
        list.setPointerCapture(pointerId);
        list.focus({ preventScroll: true });
      }
      e.preventDefault();
      const bounds = list.getBoundingClientRect();
      if (e.clientY > bounds.bottom - 20) list.scrollTop += 12;
      else if (e.clientY < bounds.top + 20) list.scrollTop -= 12;
      if (e.clientX > bounds.right - 20) list.scrollLeft += 12;
      else if (e.clientX < bounds.left + 20) list.scrollLeft -= 12;
      const point = {
        x: e.clientX - bounds.left + list.scrollLeft,
        y: e.clientY - bounds.top + list.scrollTop,
      };
      update(point, bounds);
    };
    const update = (point: { x: number; y: number }, bounds: DOMRect) => {
      const box = {
        left: Math.min(start.x, point.x),
        top: Math.min(start.y, point.y),
        right: Math.max(start.x, point.x),
        bottom: Math.max(start.y, point.y),
      };
      Object.assign(rectangle!.style, {
        left: box.left + "px",
        top: box.top + "px",
        width: box.right - box.left + "px",
        height: box.bottom - box.top + "px",
      });
      const names = options
        .rows()
        .filter((row) => {
          const r = row.getBoundingClientRect();
          return intersects(box, {
            left: r.left - bounds.left + list.scrollLeft,
            right: r.right - bounds.left + list.scrollLeft,
            top: r.top - bounds.top + list.scrollTop,
            bottom: r.bottom - bounds.top + list.scrollTop,
          });
        })
        .map((row) => row.dataset.name!);
      selection.rectangle(names, base);
      options.paint();
    };
    const scroll = () => {
      if (done || !dragged) return;
      if (!options.current() || !list.isConnected) {
        finish(true);
        return;
      }
      const bounds = list.getBoundingClientRect();
      update(
        {
          x: lastPoint.x - bounds.left + list.scrollLeft,
          y: lastPoint.y - bounds.top + list.scrollTop,
        },
        bounds,
      );
    };
    cancelCurrent = abort;
    options.active(true, abort);
    document.addEventListener("pointermove", move, {
      capture: true,
      passive: false,
    });
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", abort, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("dragstart", preventNativeDrag, true);
    window.addEventListener("blur", abort);
    list.addEventListener("lostpointercapture", abort);
    list.addEventListener("scroll", scroll);
  };
  return () => cancelCurrent?.();
}
