/**
 * Sheets, drawers, popovers, menus and dialogs, all on <dialog>.
 *
 * `showModal()` gives the rules the design asks for: everything behind is
 * inert (Tab can't reach it, screen readers don't read it) and focus moves
 * inside. On top of that: Esc or a tap on the scrim closes it, and focus
 * goes back to the button that opened it.
 *
 * A popover or menu is placed under (or above) the button that opened it
 * on a wide screen; on a phone the same dialog becomes a bottom sheet by
 * CSS (`.pop` / `.sheet-on-phone`).
 */

const closers = new WeakMap();

/**
 * Open a dialog. `reason` passed to onClose: "done" (code asked), "scrim"
 * (a tap outside) or "cancel" (Esc).
 */
export function openOverlay(dialog, { opener = document.activeElement, anchor = null, onClose = null, focus = null } = {}) {
  if (dialog.open) closeOverlay(dialog, "replace");
  let reason = "done";
  const onClick = (e) => {
    if (e.target === dialog) {
      reason = "scrim";
      dialog.close();
    }
  };
  const onCancel = () => {
    reason = "cancel";
  };
  const onClosed = () => {
    dialog.removeEventListener("click", onClick);
    dialog.removeEventListener("cancel", onCancel);
    dialog.removeEventListener("close", onClosed);
    closers.delete(dialog);
    onClose?.(reason);
    if (reason !== "replace" && opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
  };
  closers.set(dialog, (r) => {
    reason = r;
    dialog.close();
  });
  dialog.addEventListener("click", onClick);
  dialog.addEventListener("cancel", onCancel);
  dialog.addEventListener("close", onClosed);
  dialog.showModal();
  if (anchor) place(dialog, anchor);
  const target = focus ? dialog.querySelector(focus) : null;
  if (target) target.focus();
  return dialog;
}

export function closeOverlay(dialog, reason = "done") {
  const close = closers.get(dialog);
  if (close) close(reason);
  else if (dialog.open) dialog.close();
}

/** Put a popover next to the button that opened it (wide screens only; phones get a bottom sheet). */
export function place(dialog, anchor) {
  if (matchMedia("(max-width: 899px)").matches && dialog.classList.contains("sheet-on-phone")) {
    dialog.style.left = dialog.style.top = "";
    return;
  }
  const a = anchor.getBoundingClientRect();
  const d = dialog.getBoundingClientRect();
  const gap = 8;
  let left = Math.min(Math.max(8, a.left), innerWidth - d.width - 8);
  if (dialog.dataset.align === "end") left = Math.min(Math.max(8, a.right - d.width), innerWidth - d.width - 8);
  let top = a.bottom + gap;
  if (dialog.dataset.side === "above" || top + d.height > innerHeight - 8) top = Math.max(8, a.top - gap - d.height);
  dialog.style.left = `${Math.round(left)}px`;
  dialog.style.top = `${Math.round(top)}px`;
}

/** A small confirmation: resolves true when the confirming button is pressed. */
export function confirmDialog({ title, body, confirm, keep = "keep it", danger = true, opener, icon = null, alt = null }) {
  const dialog = document.getElementById("confirm-dialog");
  // The confirm button's icon: a bin unless the caller brings its own (an SVG string).
  const mark = dialog.querySelector("#confirm-icon");
  mark.dataset.bin ??= mark.innerHTML;
  mark.innerHTML = icon ?? mark.dataset.bin;
  dialog.querySelector("#confirm-title").textContent = title;
  const desc = dialog.querySelector("#confirm-body");
  desc.replaceChildren(...[body].flat().map((t) => Object.assign(document.createElement("p"), { textContent: t })));
  const yes = dialog.querySelector("[data-confirm]");
  const no = dialog.querySelector("[data-keep]");
  // A third way out (say, "branch instead"): resolves to "alt".
  const other = dialog.querySelector("[data-alt]");
  other.hidden = !alt;
  other.textContent = alt ?? "";
  yes.lastChild.textContent = confirm;
  yes.className = `btn ${danger ? "btn-danger" : "btn-primary"} press`;
  no.textContent = keep;
  return new Promise((resolve) => {
    let ok = false;
    const onYes = () => {
      ok = true;
      closeOverlay(dialog);
    };
    const onAlt = () => {
      ok = "alt";
      closeOverlay(dialog);
    };
    const onNo = () => closeOverlay(dialog);
    yes.addEventListener("click", onYes);
    no.addEventListener("click", onNo);
    other.addEventListener("click", onAlt);
    openOverlay(dialog, {
      opener,
      focus: "[data-keep]",
      onClose: () => {
        yes.removeEventListener("click", onYes);
        no.removeEventListener("click", onNo);
        other.removeEventListener("click", onAlt);
        resolve(ok);
      },
    });
  });
}
