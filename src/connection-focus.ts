/** One initial focus per displayed form. No secret values are inspected. */
export function createConnectionFocus() {
  let shown: HTMLFormElement | undefined;
  let interaction = 0;
  const touched = () => {
    interaction++;
  };
  for (const event of ["pointerdown", "keydown", "focusin"])
    document.addEventListener(event, touched, true);
  return {
    show(form?: HTMLFormElement) {
      if (shown === form) return;
      shown = form;
      if (!form) return;
      const epoch = interaction;
      const input = form.querySelector<HTMLInputElement>("[name=passphrase]");
      requestAnimationFrame(() => {
        if (
          shown !== form ||
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
