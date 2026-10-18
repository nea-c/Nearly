const fields = "form,input,textarea";

/** Suppress browser/app suggestion intent without touching values or saved data. */
export function installInputPolicy(document: Document): () => void {
  const apply = (element: Element) => {
    if (!element.matches(fields)) return;
    if (element.getAttribute("autocomplete") !== "off")
      element.setAttribute("autocomplete", "off");
    // Detach the suggestion source, retaining its nodes and data unchanged.
    if (element.matches("input[list]")) element.removeAttribute("list");
  };
  const scan = (root: ParentNode) => {
    if (root instanceof Element) apply(root);
    root.querySelectorAll(fields).forEach(apply);
  };
  scan(document);
  const observer = new MutationObserver(records => {
    const roots = new Set<Element>();
    const changed = new Set<Element>();
    for (const record of records) {
      if (record.type === "attributes") changed.add(record.target as Element);
      else for (const node of record.addedNodes)
        if (node instanceof Element && node.isConnected) roots.add(node);
    }
    // Each inserted subtree is scanned once; unrelated redraws never rescan the document.
    for (const root of roots) {
      let ancestor = root.parentElement;
      while (ancestor && !roots.has(ancestor)) ancestor = ancestor.parentElement;
      if (!ancestor) scan(root);
    }
    for (const element of changed) if (element.isConnected) apply(element);
  });
  observer.observe(document, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["autocomplete", "list"],
  });
  // Dialogs may focus synchronously, before the observer's microtask runs.
  const focus = (event: FocusEvent) => {
    if (event.target instanceof Element) {
      const form = event.target.closest("form");
      if (form) apply(form);
      apply(event.target);
    }
  };
  document.addEventListener("focusin", focus, true);
  return () => {
    observer.disconnect();
    document.removeEventListener("focusin", focus, true);
  };
}
