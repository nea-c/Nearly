import { bindTabDrag, type TabDragOptions } from "./tab-drag.js";

let scrollLeft = 0;
let revealActive = true;
export function revealSelectedTab() {
  revealActive = true;
}
export function captureTabStrip() {
  const tabs = document.querySelector<HTMLElement>(".tabs");
  if (tabs) scrollLeft = tabs.scrollLeft;
}
export function bindTabStrip(options: TabDragOptions = {}) {
  const tabs = document.querySelector<HTMLElement>(".tabs");
  if (!tabs) return;
  bindTabDrag(tabs, options);
  // Set sizing before measuring/restoring scroll; release CSP blocks markup styles.
  tabs.closest<HTMLElement>(".titlebar")?.style.setProperty(
    "--tab-count",
    String(tabs.querySelectorAll(".tab").length),
  );
  tabs.scrollLeft = scrollLeft;
  tabs.onscroll = () => {
    scrollLeft = tabs.scrollLeft;
  };
  if (revealActive) {
    revealActive = false;
    const active = tabs.querySelector<HTMLElement>(".tab.active");
    if (active) {
      const viewport = tabs.getBoundingClientRect(),
        bounds = active.getBoundingClientRect();
      if (bounds.left < viewport.left)
        tabs.scrollLeft -= viewport.left - bounds.left;
      else if (bounds.right > viewport.right)
        tabs.scrollLeft += bounds.right - viewport.right;
      scrollLeft = tabs.scrollLeft;
    }
  }
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey || tabs.scrollWidth <= tabs.clientWidth) return;
    const delta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;
    if (!delta) return;
    const scale =
      event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? tabs.clientWidth : 1;
    event.preventDefault();
    event.stopPropagation();
    tabs.scrollLeft += delta * scale;
    scrollLeft = tabs.scrollLeft;
  };
  tabs.addEventListener("wheel", wheel, { passive: false });
  document
    .querySelector(".title-drag")
    ?.addEventListener("wheel", wheel as EventListener, { passive: false });
}
