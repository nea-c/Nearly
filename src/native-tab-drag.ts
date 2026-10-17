import {invoke, type TabDragStatus, type TabStripRect} from "./api.js";
import {t} from "./i18n.js";

let label: string | undefined;
let feedback: TabDragStatus | undefined;
let sending = false;
let publication: Promise<void> = Promise.resolve();
let suppressClickUntil = 0;
let detachedWorkspace: string | undefined;
export function detachedPreviewReady(id:string){return detachedWorkspace===id;}
function markDetachedWorkspace(id?:string){
  detachedWorkspace=id;
  for(const node of document.querySelectorAll<HTMLElement>(".tab")){
    node.classList.toggle("tab-detached-source",!!id && node.querySelector<HTMLElement>("[data-tab]")?.dataset.tab===id);
  }
}
const rect = (r: DOMRect): TabStripRect => ({x:r.x,y:r.y,width:r.width,height:r.height});
export function publishTabStrip(force = false): Promise<void> {
  if (!label) return Promise.resolve();
  if(sending) return force ? publication.then(()=>publishTabStrip(true)) : publication;
  const tabs = document.querySelector<HTMLElement>(".tabs");
  if (!tabs) return Promise.resolve();
  const bounds = tabs.getBoundingClientRect();
  // The title-drag spacer is a drop-to-end target. Stop before settings and
  // caption controls; extending to the whole header would make those targets.
  const spacer = document.querySelector<HTMLElement>(".titlebar .title-drag")?.getBoundingClientRect();
  const items = Array.from(tabs.querySelectorAll<HTMLElement>(".tab")).flatMap(node => {
    const workspaceId = node.querySelector<HTMLElement>("[data-tab]")?.dataset.tab;
    const r = node.getBoundingClientRect();
    return workspaceId && node.dataset.transferIncoming !== "true" ? [{workspaceId,rect:rect(r)}] : [];
  });
  sending = true;
  publication = invoke("register_tab_strip", {geometry:{rect:rect(bounds),...(spacer?{appendRect:rect(spacer)}:{}),items,viewport:{width:innerWidth,height:innerHeight}}})
    .catch(() => {}).finally(() => {sending = false;});
  paintFeedback();
  return publication;
}
function paintFeedback() {
  let hint=document.querySelector<HTMLElement>(".tab-merge-hint");
  const foreignTarget=feedback?.phase === "dragging" && feedback.sourceLabel === label && feedback.targetLabel && feedback.targetLabel !== label;
  if (!foreignTarget) hint?.remove();
  else {
    if (!hint) {
      hint=document.createElement("div");hint.className="tab-merge-hint";
      hint.setAttribute("role","status");
      const status=document.createElement("span");status.className="tab-merge-status";
      hint.append(status);document.body.append(hint);
    }
    const message=feedback!.beforeId ? t("別のウィンドウに結合") : t("別のウィンドウの末尾に結合");
    const status=hint.querySelector<HTMLElement>(".tab-merge-status")!;
    if(status.textContent!==message)status.textContent=message;

  }
  let marker=document.querySelector<HTMLElement>(".tab-drop-indicator");
  const tabs = document.querySelector<HTMLElement>(".tabs");
  if (!tabs || feedback?.phase !== "dragging" || feedback.targetLabel !== label || feedback.sourceLabel === label) {
    marker?.remove(); return;
  }
  const nodes = Array.from(tabs.querySelectorAll<HTMLElement>(".tab"))
    .filter(node => node.querySelector<HTMLElement>("[data-tab]")?.dataset.tab !== feedback!.workspaceId);
  const before = nodes.find(node => node.querySelector<HTMLElement>("[data-tab]")?.dataset.tab === feedback!.beforeId);
  const bounds = tabs.getBoundingClientRect();
  const x = before ? before.getBoundingClientRect().left : nodes.at(-1)?.getBoundingClientRect().right ?? bounds.left;
  if(!marker) {
    marker = document.createElement("div");
    marker.className = "tab-drop-indicator";
    marker.setAttribute("aria-hidden", "true");
    document.body.append(marker);
  }
  marker.style.left = `${Math.max(bounds.left,Math.min(bounds.right-3,x))}px`;
  marker.style.top = `${bounds.top+4}px`;
  marker.style.height = `${Math.max(0,bounds.height-8)}px`;
}
export async function initializeNativeTabDrag(windowLabel: string, accept: (status: TabDragStatus) => void) {
  label = windowLabel;
  await window.__TAURI__?.event?.listen<TabDragStatus>("tab-drag", event => {
    feedback = event.payload;
    if(feedback.phase!=="dragging" || (detachedWorkspace && detachedWorkspace!==feedback.workspaceId)) markDetachedWorkspace();
    suppressClickUntil = performance.now() + 600;
    paintFeedback();
    accept(event.payload);
  });
  await window.__TAURI__?.event?.listen<{workspaceId:string;dragId:string}>("tab-drag-preview-ready",event=>{
    const ready=event.payload;
    if(feedback?.phase==="dragging"&&feedback.sourceLabel===label&&feedback.dragId===ready?.dragId&&feedback.workspaceId===ready.workspaceId)markDetachedWorkspace(ready.workspaceId);
  });
  document.addEventListener("click", event => {
    if (event.detail === 0 || (feedback?.phase !== "dragging" && performance.now() > suppressClickUntil)) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  document.addEventListener("pointerdown", () => {
    // Suppress the drag's release click, while a subsequent fresh press keeps
    // normal tab/close actions responsive after a completed window move.
    if (feedback?.phase !== "dragging") suppressClickUntil = 0;
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
