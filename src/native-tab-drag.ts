import {invoke, type TabDragStatus, type TabStripRect} from "./api.js";

let label: string | undefined;
let feedback: TabDragStatus | undefined;
let sending = false;
let publication: Promise<void> = Promise.resolve();
let suppressClickUntil = 0;
const rect = (r: DOMRect): TabStripRect => ({x:r.x,y:r.y,width:r.width,height:r.height});
export function publishTabStrip(force = false): Promise<void> {
  if (!label) return Promise.resolve();
  if(sending) return force ? publication.then(()=>publishTabStrip(true)) : publication;
  const tabs = document.querySelector<HTMLElement>(".tabs");
  if (!tabs) return Promise.resolve();
  const bounds = tabs.getBoundingClientRect();
  const items = Array.from(tabs.querySelectorAll<HTMLElement>(".tab")).flatMap(node => {
    const workspaceId = node.querySelector<HTMLElement>("[data-tab]")?.dataset.tab;
    const r = node.getBoundingClientRect();
    return workspaceId && node.dataset.transferIncoming !== "true" ? [{workspaceId,rect:rect(r)}] : [];
  });
  sending = true;
  publication = invoke("register_tab_strip", {geometry:{rect:rect(bounds),items,viewport:{width:innerWidth,height:innerHeight}}})
    .catch(() => {}).finally(() => {sending = false;});
  paintFeedback();
  return publication;
}
function paintFeedback() {
  document.querySelector(".tab-drop-indicator")?.remove();
  const tabs = document.querySelector<HTMLElement>(".tabs");
  if (!tabs || feedback?.phase !== "dragging" || feedback.targetLabel !== label) return;
  const nodes = Array.from(tabs.querySelectorAll<HTMLElement>(".tab"))
    .filter(node => node.querySelector<HTMLElement>("[data-tab]")?.dataset.tab !== feedback!.workspaceId);
  const before = nodes.find(node => node.querySelector<HTMLElement>("[data-tab]")?.dataset.tab === feedback!.beforeId);
  const bounds = tabs.getBoundingClientRect();
  const x = before ? before.getBoundingClientRect().left : nodes.at(-1)?.getBoundingClientRect().right ?? bounds.left;
  const marker = document.createElement("div");
  marker.className = "tab-drop-indicator";
  marker.setAttribute("aria-hidden", "true");
  marker.style.left = `${Math.max(bounds.left,Math.min(bounds.right-3,x))}px`;
  marker.style.top = `${bounds.top+4}px`;
  marker.style.height = `${Math.max(0,bounds.height-8)}px`;
  document.body.append(marker);
}
export async function initializeNativeTabDrag(windowLabel: string, accept: (status: TabDragStatus) => void) {
  label = windowLabel;
  await window.__TAURI__?.event?.listen<TabDragStatus>("tab-drag", event => {
    feedback = event.payload;
    suppressClickUntil = performance.now() + 600;
    paintFeedback();
    accept(event.payload);
  });
  document.addEventListener("click", event => {
    if (event.detail === 0 || (feedback?.phase !== "dragging" && performance.now() > suppressClickUntil)) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  // Inactive windows also publish, so they can be discovered as drop targets.
  setInterval(()=>{void publishTabStrip();}, 450);
  window.addEventListener("resize", ()=>{void publishTabStrip();});
  document.addEventListener("scroll", ()=>{void publishTabStrip();}, true);
  window.addEventListener("pagehide", () => { void invoke("register_tab_strip",{geometry:null}).catch(()=>{}); });
}

/** Native return-to-source reorders the original header nodes without repainting. */
export function reorderTabNodes(ids: string[]) {
  const tabs = document.querySelector<HTMLElement>(".tabs");
  if (!tabs) return;
  const nodes = new Map(Array.from(tabs.querySelectorAll<HTMLElement>(".tab"))
    .map(node => [node.querySelector<HTMLElement>("[data-tab]")?.dataset.tab,node]));
  for (const id of ids) { const node=nodes.get(id); if(node) tabs.append(node); }
  publishTabStrip();
}
