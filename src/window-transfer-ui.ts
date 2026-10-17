import { getLanguage } from "./i18n.js";

export const transferText = (ja: string, en: string) => getLanguage() === "ja" ? ja : en;
let menu: HTMLElement | undefined;
export function closeWindowTransferMenu() { menu?.remove(); menu = undefined; }
document.addEventListener("pointerdown", event => {
  if (menu && !menu.contains(event.target as Node)) closeWindowTransferMenu();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && menu) { event.preventDefault(); closeWindowTransferMenu(); }
});
export function bindWindowTransferMenu(options: {
  enabled: boolean;
  busy(id: string): boolean;
  move(id: string): void;
}) {
  closeWindowTransferMenu();
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach(tab => {
    const open = (x: number, y: number) => {
      if (!options.enabled) return;
      closeWindowTransferMenu();
      const id = tab.dataset.tab!;
      menu = document.createElement("div");
      menu.className = "window-transfer-menu";
      menu.setAttribute("role", "menu");
      const item = document.createElement("button");
      item.setAttribute("role", "menuitem");
      item.dataset.tabMoveWindow = id;
      item.textContent = transferText("新しいウィンドウに移動", "Move to new window");
      item.disabled = options.busy(id);
      item.onclick = () => { closeWindowTransferMenu(); options.move(id); };
      item.onkeydown = event => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) event.preventDefault();
        if (event.key === "Escape") { closeWindowTransferMenu(); tab.focus(); }
        if (event.key === "Tab") closeWindowTransferMenu();
      };
      menu.append(item); document.body.append(menu);
      const bounds = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(0, Math.min(x, innerWidth - bounds.width))}px`;
      menu.style.top = `${Math.max(0, Math.min(y, innerHeight - bounds.height))}px`;
      item.focus();
    };
    tab.oncontextmenu = event => { event.preventDefault(); open(event.clientX, event.clientY); };
    tab.addEventListener("keydown", event => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault(); const bounds = tab.getBoundingClientRect(); open(bounds.left, bounds.bottom);
      }
    });
  });
}
