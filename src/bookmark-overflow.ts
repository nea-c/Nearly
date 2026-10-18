// One physical copy of each item: overflow menus temporarily host the original nodes.
export const overflowIcon =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m3 4 4 4-4 4m6-8 4 4-4 4"/></svg>';
let disposers: (() => void)[] = [];
export function disposeBookmarkRows() {
  for (const dispose of disposers.splice(0)) dispose();
}
export function bindBookmarkOverflow(
  root: HTMLElement,
  open: (items: HTMLElement[], keyboard: boolean) => void,
  close: () => void,
) {
  const strip = root.querySelector<HTMLElement>(".bookmark-items")!;
  const more = root.querySelector<HTMLButtonElement>(
    "[data-bookmark-overflow]",
  )!;
  const items = [...strip.children].filter(
    (e): e is HTMLElement => e instanceof HTMLElement && e.tagName === "BUTTON",
  );
  const widths = new Map<HTMLElement, number>();
  let lastWidth = -1;
  const measure = () => {
    if (!root.isConnected) return;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const focusedItem = items.find(item => item === focused || !!focused && item.contains(focused));
    const ownsFocus = focused === more || !!focusedItem || !!focused &&
      focused !== document.body && focused !== document.documentElement && items.some(item => focused.contains(item));
    close();
    more.hidden = true;
    for (const item of items) {
      item.hidden = false;
      widths.set(item, item.getBoundingClientRect().width);
    }
    const gap = parseFloat(getComputedStyle(strip).gap) || 0;
    const total =
      items.reduce((n, item) => n + widths.get(item)! + gap, 0) - gap;
    const available = strip.clientWidth;
    const overflowing = total > available + 0.5;
    more.hidden = !overflowing;
    const budget = overflowing ? Math.max(0, available - 30) : available;
    let used = 0,
      hidden = false;
    for (const item of items) {
      const width = widths.get(item)! + (used ? gap : 0);
      hidden ||= used + width > budget + 0.5;
      item.hidden = hidden;
      if (!hidden) used += width;
    }
    lastWidth = root.getBoundingClientRect().width;
    // Measuring briefly hides the overflow button. Keep its logical focus
    // instead of letting resize/font/layout work silently send focus to body.
    if (ownsFocus && (document.activeElement === document.body || document.activeElement === focused)) {
      const target = focusedItem && !focusedItem.hidden ? focusedItem : !more.hidden ? more : root;
      target.focus({ preventScroll: true });
    }
  };
  more.onclick = (event) => {
    if (more.getAttribute("aria-expanded") === "true") {
      close();
      return;
    }
    open(items.filter((i) => i.hidden), event.detail === 0);
  };
  const observer = new ResizeObserver(() => {
    if (Math.abs(root.getBoundingClientRect().width - lastWidth) > 0.5)
      measure();
  });
  observer.observe(root);
  measure();
  const fonts = () => measure();
  document.fonts?.addEventListener("loadingdone", fonts);
  disposers.push(() => {
    observer.disconnect();
    document.fonts?.removeEventListener("loadingdone", fonts);
    close();
  });
}
export function focusBookmarkMenu(view: HTMLElement, keyboard: boolean) {
  view.tabIndex = -1;
  const target = keyboard ? view.querySelector<HTMLElement>("button:not(:disabled)") : undefined;
  (target ?? view).focus({ preventScroll: true });
}
export function menuKeys(view: HTMLElement, close: () => void) {
  view.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if (
      !event.defaultPrevented &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      event.preventDefault();
      const buttons = [
        ...view.querySelectorAll<HTMLElement>("button:not(:disabled)"),
      ];
      const index = buttons.indexOf(document.activeElement as HTMLElement);
      const next = index < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1) :
        (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next]?.focus();
    }
  });
}
