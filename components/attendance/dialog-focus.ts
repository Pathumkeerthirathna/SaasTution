/*
 * Keyboard focus management for modal dialogs (the attendance finalization
 * dialog, Stage 5.5d-4 accessibility follow-up). Framework-free and
 * DOM-light (the container and the active element are injected), so it is
 * tested without a browser.
 *
 *  - activate(): remembers the element that had focus (the trigger) and
 *    moves focus into the dialog: the element marked data-autofocus (a
 *    non-destructive one, e.g. Cancel), else the first focusable element,
 *    else the dialog container itself (tabIndex -1);
 *  - handleKeyDown(): Tab / Shift+Tab cycle inside the dialog only (wrapping
 *    at both ends; focus that escaped is brought back); Escape closes the
 *    dialog only while closing is allowed (never while submitting);
 *  - deactivate(): returns focus to the trigger, or to a fallback when the
 *    trigger is gone (e.g. the "Preview finalization" button disappears once
 *    the register is finalized).
 */

/** Focusable, enabled elements (disabled controls and tabindex="-1" are skipped by the browser too). */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(", ");

export type FocusTarget = { focus: (options?: { preventScroll?: boolean }) => void; isConnected?: boolean };

// Method syntax (not function properties): a real HTMLElement fits, whose contains() takes a Node.
export type FocusContainer = FocusTarget & {
  querySelectorAll(selector: string): ArrayLike<FocusTarget>;
  querySelector(selector: string): FocusTarget | null;
  contains(node: FocusTarget | null): boolean;
};

export type FocusKeyEvent = { key: string; shiftKey: boolean; preventDefault: () => void };

export type DialogFocusDeps = {
  container: () => FocusContainer | null;
  activeElement: () => FocusTarget | null;
  /** False while the dialog must stay open (e.g. while finalization is submitting). */
  canClose: () => boolean;
  onClose: () => void;
  /** Where focus goes on close when the trigger no longer exists. */
  fallback?: () => void;
};

export function createDialogFocusManager(deps: DialogFocusDeps) {
  let trigger: FocusTarget | null = null;
  let active = false;

  const focusables = (container: FocusContainer) => Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));

  return {
    activate() {
      if (active) return;
      active = true;
      trigger = deps.activeElement();
      const container = deps.container();
      if (!container) return;
      const target = container.querySelector("[data-autofocus]:not([disabled])") ?? focusables(container)[0] ?? container;
      target.focus({ preventScroll: true });
    },

    /** Brings focus back inside (e.g. after the focused control became disabled). */
    refocus() {
      const container = deps.container();
      if (container && !container.contains(deps.activeElement())) container.focus({ preventScroll: true });
    },

    handleKeyDown(event: FocusKeyEvent) {
      if (!active) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (deps.canClose()) deps.onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const container = deps.container();
      if (!container) return;
      const items = focusables(container);
      const current = deps.activeElement();
      if (items.length === 0) {
        // Nothing to move to (e.g. every control disabled while submitting): stay on the dialog.
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = current !== null && current !== container && container.contains(current);
      if (event.shiftKey) {
        if (!inside || current === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || current === last) {
        event.preventDefault();
        first.focus();
      }
    },

    deactivate() {
      if (!active) return;
      active = false;
      const target = trigger;
      trigger = null;
      if (target && target.isConnected !== false) target.focus({ preventScroll: true });
      else deps.fallback?.();
    },
  };
}

export type DialogFocusManager = ReturnType<typeof createDialogFocusManager>;
