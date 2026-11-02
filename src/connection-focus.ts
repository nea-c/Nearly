/** One initial focus per displayed form. No secret values are inspected. */
export function createConnectionFocus() {
  let shown: HTMLFormElement | undefined;
  let shownOwner: object | undefined;
  const initialOwners = new WeakSet<object>();
  let interaction = 0;
  const touched = () => {
    interaction++;
  };
  for (const event of ["pointerdown", "keydown", "focusin"])
    document.addEventListener(event, touched, true);
  return {
    show(form?: HTMLFormElement, options: { onceFor?: object } = {}) {
      const owner = options.onceFor;
      const alreadyShown = owner ? initialOwners.has(owner) : false;
      if (owner && !form) initialOwners.add(owner);
      shownOwner = owner;
      if (shown === form) return;
      shown = form;
      if (!form || alreadyShown) return;
      const epoch = interaction;
      const input = form.querySelector<HTMLInputElement>("[name=passphrase]");
      requestAnimationFrame(() => {
        if (shown !== form) {
          if (owner && shownOwner !== owner) initialOwners.add(owner);
          return;
        }
        // A form replaced during bootstrap has not consumed its owner's first
        // attempt. User interaction or an unavailable current field does.
        if (owner) {
          if (initialOwners.has(owner)) return;
          initialOwners.add(owner);
        }
        if (
          interaction !== epoch ||
          !input?.isConnected ||
          input.disabled ||
          input.readOnly ||
          input.getClientRects().length === 0 ||
          input.closest("[inert],[hidden],[aria-hidden=true]")
        )
          return;
        if (
          document.querySelector(
            ".overlay,[role=dialog][aria-modal=true],#settings-root:not(:empty)",
          )
        )
          return;
        input.focus({ preventScroll: true });
      });
    },
  };
}
