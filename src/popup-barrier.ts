/** Make a portalled popup modal without moving its content or changing save behavior. */
export function popupBarrier(surface: HTMLElement, dismiss: () => void, layer: number, target?: HTMLElement) {
  const backdrop = document.createElement('div');
  backdrop.className = 'popup-backdrop';
  backdrop.style.zIndex = String(layer);
  document.body.append(backdrop);
  const inert = new Map<HTMLElement, boolean>();
  // Inert siblings along the portal's ancestry, including a retained overflow menu.
  for (let branch: HTMLElement | null = surface; branch?.parentElement; branch = branch.parentElement) {
    if (branch === document.body) break;
    for (const sibling of branch.parentElement.children) {
      if (sibling instanceof HTMLElement && sibling !== branch && sibling !== backdrop) {
        inert.set(sibling, sibling.inert); sibling.inert = true;
      }
    }
  }
  target?.setAttribute('data-bookmark-context-target', 'true');
  let disposed = false;
  let outsidePointer: {id:number; button:number; released:boolean} | undefined;
  const childPopup = () => [...document.querySelectorAll<HTMLElement>('dialog[open],[role=dialog],[role=menu],.overlay,.bookmark-tree-overlay')]
    .filter(element => !surface.contains(element) && !element.contains(surface) && !element.closest('[inert]') && element.getClientRects().length).at(-1);
  const controls = () => [...surface.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.closest('[hidden],[inert]') && element.getClientRects().length > 0);
  const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const pointer = (event: Event) => {
    if (event.type === 'pointerdown') outsidePointer = undefined;
    if (childPopup()) return;
    if (event instanceof PointerEvent && ['pointerup','pointercancel'].includes(event.type) && outsidePointer?.id === event.pointerId) {
      // A gesture that began outside must not deliver its release to popup controls.
      if (event.type === 'pointercancel') outsidePointer = undefined;
      else outsidePointer.released = true;
      stop(event); return;
    }
    if (event.target instanceof Node && surface.contains(event.target)) return;
    stop(event);
    if (event instanceof PointerEvent && event.type === 'pointerdown') outsidePointer = {id:event.pointerId,button:event.button,released:false};
    if (['click','auxclick','contextmenu'].includes(event.type)) dismiss();
  };
  const keys = (event: KeyboardEvent) => {
    if (childPopup()) return;
    if (event.key === 'Escape') { stop(event); dismiss(); return; }
    if (event.key === 'F5' || event.altKey && ['ArrowLeft','ArrowRight','Home'].includes(event.key) ||
        (event.ctrlKey || event.metaKey) && ['t','w','Tab'].includes(event.key)) { stop(event); return; }
    if (event.key === 'Tab') {
      stop(event);
      const items = controls(), index = items.indexOf(document.activeElement as HTMLElement);
      const next = index < 0 ? (event.shiftKey ? items.length - 1 : 0) : (index + (event.shiftKey ? items.length - 1 : 1)) % items.length;
      items[next]?.focus({preventScroll:true});
    } else if (!(event.target instanceof Node) || !surface.contains(event.target)) stop(event);
  };
  const focus = (event: FocusEvent) => {
    if (!childPopup() && event.target instanceof Node && !surface.contains(event.target))
      controls()[0]?.focus({preventScroll:true});
  };
  // Let controls process ordinary keys, then keep app-wide window shortcuts out.
  const stopShortcuts = (event: KeyboardEvent) => { if (!childPopup()) event.stopPropagation(); };
  const events = ['pointerdown','pointerup','pointercancel','mousedown','mouseup','click','dblclick','auxclick','contextmenu','wheel'];
  events.forEach(type => document.addEventListener(type, pointer, {capture:true, passive:false}));
  document.addEventListener('keydown', keys, true);
  document.addEventListener('keydown', stopShortcuts);
  document.addEventListener('focusin', focus, true);
  const observer = new MutationObserver(() => {
    if (!surface.isConnected || target && !target.isConnected) dismiss();
  });
  observer.observe(document.body, {childList:true, subtree:true});
  return () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    events.forEach(type => document.removeEventListener(type, pointer, true));
    document.removeEventListener('keydown', keys, true);
    document.removeEventListener('keydown', stopShortcuts);
    document.removeEventListener('focusin', focus, true);
    backdrop.remove();
    inert.forEach((previous, element) => { element.inert = previous; });
    target?.removeAttribute('data-bookmark-context-target');
    // Windows may emit contextmenu before pointerup. Consume that gesture's tail,
    // but never the next deliberate pointerdown/click.
    if (outsidePointer) {
      const held = outsidePointer;
      let released = held.released;
      const events = ['pointerup','pointercancel','mouseup','click','auxclick','contextmenu'];
      const clear = () => {
        events.forEach(type => document.removeEventListener(type, tail, true));
        document.removeEventListener('pointerdown', clear, true);
      };
      const tail = (event: Event) => {
        if (event instanceof PointerEvent && ['pointerup','pointercancel'].includes(event.type)) {
          if (event.pointerId !== held.id) return;
          stop(event); released = true;
          if (event.type === 'pointercancel') clear();
        } else if (event instanceof MouseEvent && event.button === held.button) {
          // A keyboard/programmatic click after release is a distinct interaction.
          if (released && event.type === 'click' && event.detail === 0) { clear(); return; }
          stop(event);
        }
      };
      // No clock can prove a held gesture ended. Retain compatibility-event
      // suppression through release; cancellation or the next gesture clears it.
      events.forEach(type => document.addEventListener(type, tail, true));
      document.addEventListener('pointerdown', clear, true);
    }
  };
}
