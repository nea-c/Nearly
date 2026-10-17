import { bindPointerReorder, cancelPointerReorder, type DragPoint } from "./pointer-reorder.js";

export type TabDragOptions = { reorder?: (ids: string[]) => void; busy?: () => boolean;
  externalStart?: (id: string, grab: {x: number; y: number}, title: string) => void };
type Destination = { ids: string[]; scroll: number; left: number; top: number };
type SavedStyle = { node: HTMLElement; style: string | null };
const bindings = new WeakMap<HTMLElement, () => void>();

/** The existing pointer controller owns capture, cancellation, and click suppression. */
export function bindTabDrag(tabs: HTMLElement, options: TabDragOptions) {
  bindings.get(tabs)?.();
  let session: {
    source: HTMLElement; original: HTMLElement[]; placeholder: HTMLElement;
    styles: SavedStyle[]; scroll: number; grab: number; grabY: number; width: number; top: number;
    point: DragPoint; observedScroll: number;
    animations: Map<HTMLElement, Animation>;
  } | undefined;
  const children = () => Array.from(tabs.children).filter((node): node is HTMLElement =>
    node instanceof HTMLElement && node.classList.contains("tab"));
  const id = (node: HTMLElement) => node.querySelector<HTMLElement>("[data-tab]")?.dataset.tab;
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const update = (source: HTMLElement, point: DragPoint): Destination | undefined => {
    const current = session;
    if (!current) return;
    current.point = point;
    current.observedScroll = tabs.scrollLeft;
    const viewport = tabs.getBoundingClientRect();
    if (point.x < viewport.left || point.x > viewport.right ||
        point.y < viewport.top || point.y > viewport.bottom) {
      if (options.externalStart) {
        const outside = Math.max(viewport.left - point.x, point.x - viewport.right,
          viewport.top - point.y, point.y - viewport.bottom);
        if (outside < 42) return;
        const workspaceId = id(source)!;
        const grab = {x: current.grab, y: current.grabY};
        const title = source.querySelector<HTMLElement>("[data-tab]")?.textContent?.trim() || "Nearly";
        // Restore the original nodes and release capture before native tracking.
        // The resulting lostpointercapture cannot cancel a native gesture.
        cancelPointerReorder();
        options.externalStart(workspaceId, grab, title);
        return;
      }
      cancelPointerReorder();
      return;
    }
    // Absolute positioning is in scroll content coordinates. Keep every pixel
    // of the floating tab inside the viewport, including during edge scrolling.
    const visibleLeft = Math.max(0, Math.min(viewport.width - current.width,
      point.x - viewport.left - current.grab));
    const left = visibleLeft + tabs.scrollLeft;
    source.style.left = `${left}px`;
    const center = left + current.width / 2;
    const siblings = children().filter(node => node !== source);
    const before = siblings.find(node => center < node.offsetLeft + node.offsetWidth / 2);
    const next = current.placeholder.nextElementSibling;
    // Skip the absolutely positioned source when comparing the insertion slot.
    const nextSibling = next === source ? next.nextElementSibling : next;
    if (nextSibling !== (before ?? null)) {
      const old = new Map(siblings.map(node => [node, node.getBoundingClientRect().left]));
      if (before) tabs.insertBefore(current.placeholder, before);
      else tabs.append(current.placeholder);
      siblings.forEach(node => {
        const previous = old.get(node)!;
        current.animations.get(node)?.cancel();
        const shift = previous - node.getBoundingClientRect().left;
        if (shift && !reduceMotion()) {
          current.animations.set(node, node.animate([
            { transform: `translateX(${shift}px)` }, { transform: "translateX(0)" },
          ], { duration: 160, easing: "cubic-bezier(.2,.8,.2,1)" }));
        }
      });
    }
    const ids = Array.from(tabs.children).flatMap(node => {
      if (node === current.placeholder) return [id(source)!];
      if (node === source || !(node instanceof HTMLElement)) return [];
      const value = id(node);
      return value ? [value] : [];
    });
    return { ids, scroll: tabs.scrollLeft, left: source.getBoundingClientRect().left,
      top: source.getBoundingClientRect().top };
  };
  const scrolled = () => {
    const current = session;
    if (!current || current.observedScroll === tabs.scrollLeft) return;
    if (options.busy?.()) { cancelPointerReorder(); return; }
    // Wheel and scrollbar scrolling can happen with a stationary pointer. The
    // shared controller updates on edge scrolling; avoid repeating that update.
    update(current.source, current.point);
  };
  const restore = () => {
    const current = session;
    if (!current) return;
    session = undefined;
    tabs.removeEventListener("scroll", scrolled);
    current.animations.forEach(animation => animation.cancel());
    current.original.forEach(node => tabs.append(node));
    current.placeholder.remove();
    current.source.classList.remove("tab-drag-source");
    current.styles.forEach(({ node, style }) => {
      if (style === null) node.removeAttribute("style");
      else node.style.cssText = style;
    });
    tabs.classList.remove("tab-reordering");
    tabs.scrollLeft = current.scroll;
  };
  const cancel = bindPointerReorder<Destination>({
    root: tabs,
    selector: ".tab",
    exclude: "[data-close]",
    busy: () => !options.reorder || (options.busy?.() ?? false),
    start: (source, event) => {
      const original = children();
      if ((!options.externalStart && original.length < 2) || original.some(node => !id(node))) return false;
      const bounds = source.getBoundingClientRect(), viewport = tabs.getBoundingClientRect();
      const placeholder = document.createElement("div");
      placeholder.className = "tab-drag-placeholder";
      placeholder.setAttribute("aria-hidden", "true");
      placeholder.style.width = `${bounds.width}px`;
      placeholder.style.height = `${bounds.height}px`;
      const styles = original.map(node => ({ node, style: node.getAttribute("style") }));
      // Freeze flex widths before taking the source out of flow.
      const widths = original.map(node => node.getBoundingClientRect().width);
      original.forEach((node, index) => {
        node.style.flex = `0 0 ${widths[index]}px`;
        node.style.minWidth = `${widths[index]}px`;
        node.style.maxWidth = `${widths[index]}px`;
      });
      const top = bounds.top - viewport.top + tabs.scrollTop;
      session = { source, original, placeholder, styles, scroll: tabs.scrollLeft,
        grab: event.clientX - bounds.left, grabY: event.clientY - bounds.top, width: bounds.width, top,
        point: { x: event.clientX, y: event.clientY }, observedScroll: tabs.scrollLeft,
        animations: new Map() };
      source.before(placeholder);
      tabs.classList.add("tab-reordering");
      source.classList.add("tab-drag-source");
      source.style.width = `${bounds.width}px`;
      source.style.left = `${bounds.left - viewport.left + tabs.scrollLeft}px`;
      source.style.top = `${top}px`;
      tabs.addEventListener("scroll", scrolled, { passive: true });
    },
    move: update,
    drop: (source, destination) => {
      // Shared cleanup restores the old DOM before this callback. Move the same
      // nodes into the accepted order; existing tab and close handlers survive.
      const nodes = new Map(children().map(node => [id(node), node]));
      const oldOrder = children().map(node => id(node));
      destination.ids.forEach(value => { const node = nodes.get(value); if (node) tabs.append(node); });
      tabs.scrollLeft = destination.scroll;
      const bounds = source.getBoundingClientRect();
      if (!reduceMotion()) source.animate([
        { transform: `translate(${destination.left - bounds.left}px, ${destination.top - bounds.top}px)` },
        { transform: "translate(0, 0)" },
      ], { duration: 140, easing: "cubic-bezier(.2,.8,.2,1)" });
      if (destination.ids.some((value, index) => value !== oldOrder[index])) options.reorder!(destination.ids);
    },
    cancel: restore,
    scrollContainers: () => [tabs],
  });
  bindings.set(tabs, cancel);
}

export { cancelPointerReorder as cancelTabDrag } from "./pointer-reorder.js";
