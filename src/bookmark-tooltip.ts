let tip: HTMLElement | undefined, anchor: HTMLElement | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
function cancelHide() {
  clearTimeout(hideTimer);
  hideTimer = undefined;
}
function hideSoon() {
  cancelHide();
  hideTimer = setTimeout(closeBookmarkTooltip, 120);
}
export function closeBookmarkTooltip() {
  cancelHide();
  tip?.remove();
  tip = undefined;
  anchor?.removeAttribute("aria-describedby");
  anchor = undefined;
}
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape") closeBookmarkTooltip();
  },
  true,
);
document.addEventListener("pointerdown", (event) => {
  if (!(event.target instanceof Node) || !tip?.contains(event.target))
    closeBookmarkTooltip();
});
window.addEventListener("blur", closeBookmarkTooltip);
export function bindBookmarkTooltip(button: HTMLElement) {
  const show = () => {
    closeBookmarkTooltip();
    const values = JSON.parse(
      button.dataset.bookmarkDescription ?? "[]",
    ) as string[];
    tip = document.createElement("div");
    tip.id = "bookmark-description";
    tip.className = "bookmark-tooltip";
    tip.setAttribute("role", "tooltip");
    values.forEach((value, i) => {
      const row = document.createElement(
        i === 0 ? "strong" : i % 2 ? "b" : "code",
      );
      row.textContent = value;
      tip!.append(row);
    });
    document.body.append(tip);
    anchor = button;
    button.setAttribute("aria-describedby", tip.id);
    const box = button.getBoundingClientRect();
    const below = Math.max(0, innerHeight - box.bottom - 13),
      above = Math.max(0, box.top - 13);
    const useBelow = below >= above;
    tip.style.maxHeight = Math.max(1, useBelow ? below : above) + "px";
    tip.style.pointerEvents =
      tip.scrollHeight > tip.clientHeight ? "auto" : "none";
    tip.onpointerenter = cancelHide;
    tip.onpointerleave = (event) => {
      if (
        event.relatedTarget instanceof Node &&
        button.contains(event.relatedTarget)
      )
        return;
      hideSoon();
    };
    tip.style.left =
      Math.max(8, Math.min(box.left, innerWidth - tip.offsetWidth - 8)) + "px";
    tip.style.top =
      Math.max(8, useBelow ? box.bottom + 5 : box.top - tip.offsetHeight - 5) +
      "px";
  };
  button.addEventListener("pointerenter", show);
  button.addEventListener("pointerleave", (event) => {
    if (
      event.relatedTarget instanceof Node &&
      tip?.contains(event.relatedTarget)
    )
      return;
    if (anchor === button) hideSoon();
  });
  button.addEventListener("keydown", (event) => {
    if (anchor !== button || !tip) return;
    if (["PageDown", "PageUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "Home") tip.scrollTop = 0;
      else if (event.key === "End") tip.scrollTop = tip.scrollHeight;
      else
        tip.scrollTop +=
          (event.key === "PageDown" ? 1 : -1) * tip.clientHeight * 0.8;
    }
  });
  button.addEventListener("focus", show);
  button.addEventListener("blur", () => {
    if (anchor === button) closeBookmarkTooltip();
  });
}
