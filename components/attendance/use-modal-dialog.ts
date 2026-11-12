"use client";

/*
 * The modal-dialog behaviour of the attendance dialogs, from the two
 * existing utilities (Stage 5.6d): keyboard focus (dialog-focus.ts) and the
 * inert background (dialog-inert.ts), in the order the finalization dialog
 * established (Stage 5.5d-4):
 *
 *   open:  remember the trigger and move focus inside (data-autofocus), THEN
 *          make the background inert (an inert trigger would lose focus),
 *          then listen for Tab / Shift+Tab / Escape;
 *   close: stop listening, restore the background, THEN return focus to the
 *          trigger (or the fallback when the trigger is gone).
 *
 * activateModalDialog is framework-free (injected DOM pieces, tested with
 * fakes); useModalDialog runs it for the dialog's lifetime (once per
 * opening, not on every state change).
 */

import { useCallback, useEffect, useRef, type RefObject } from "react";

import { createDialogFocusManager, type DialogFocusManager, type FocusContainer, type FocusKeyEvent, type FocusTarget } from "@/components/attendance/dialog-focus";
import { makeOutsideInert, type InertNode } from "@/components/attendance/dialog-inert";

export type ModalDialogDeps = {
  dialog: () => FocusContainer | null;
  /** The overlay root: everything outside it (up to stopAt) becomes inert. */
  overlay: InertNode | null;
  stopAt: InertNode | null;
  activeElement: () => FocusTarget | null;
  /** False while the dialog must stay open (e.g. while submitting): Escape does nothing. */
  canClose: () => boolean;
  onClose: () => void;
  /** Where focus goes on close when the trigger no longer exists. */
  fallback?: () => void;
  /** Subscribes to keydown; returns the unsubscribe. */
  listen: (handler: (event: FocusKeyEvent) => void) => () => void;
};

/** Opens the modal behaviour; returns the focus manager (refocus) and release() for close / unmount (idempotent). */
export function activateModalDialog(deps: ModalDialogDeps): { manager: DialogFocusManager; release: () => void } {
  const manager = createDialogFocusManager({
    container: deps.dialog,
    activeElement: deps.activeElement,
    canClose: deps.canClose,
    onClose: deps.onClose,
    fallback: deps.fallback,
  });
  manager.activate();
  const restoreBackground = deps.overlay ? makeOutsideInert(deps.overlay, deps.stopAt) : () => {};
  const unlisten = deps.listen((event) => manager.handleKeyDown(event));
  let released = false;
  return {
    manager,
    release() {
      if (released) return;
      released = true;
      unlisten();
      restoreBackground();
      manager.deactivate();
    },
  };
}

/**
 * The dialog element as the focus manager sees it. contains() means strictly
 * inside: focus resting on the dialog element itself (tabIndex -1) counts as
 * outside, so Tab / Shift+Tab from there wrap to the first / last control.
 */
export function focusContainerOf(node: HTMLElement | null): FocusContainer | null {
  if (!node) return null;
  return {
    focus: (options) => node.focus(options),
    querySelectorAll: (selector) => node.querySelectorAll<HTMLElement>(selector),
    querySelector: (selector) => node.querySelector<HTMLElement>(selector),
    contains: (target) => target instanceof Node && target !== node && node.contains(target),
  };
}

/**
 * Runs activateModalDialog while `open` (re-armed only when `open` changes).
 * Returns refocus(): brings focus back inside after the focused control was
 * disabled or removed (a step change, submitting).
 */
export function useModalDialog(input: {
  open: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  overlayRef: RefObject<HTMLElement | null>;
  canClose: () => boolean;
  onClose: () => void;
  fallbackId?: string;
}): { refocus: () => void } {
  const canCloseRef = useRef(input.canClose);
  const onCloseRef = useRef(input.onClose);
  canCloseRef.current = input.canClose;
  onCloseRef.current = input.onClose;
  const managerRef = useRef<DialogFocusManager | null>(null);
  const { open, dialogRef, overlayRef, fallbackId } = input;

  useEffect(() => {
    if (!open) return;
    const { manager, release } = activateModalDialog({
      dialog: () => focusContainerOf(dialogRef.current),
      overlay: overlayRef.current,
      stopAt: document.body,
      activeElement: () => (document.activeElement as HTMLElement | null) ?? null,
      canClose: () => canCloseRef.current(),
      onClose: () => onCloseRef.current(),
      fallback: fallbackId ? () => document.getElementById(fallbackId)?.focus({ preventScroll: true }) : undefined,
      listen: (handler) => {
        const onKey = (event: KeyboardEvent) => handler(event);
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      },
    });
    managerRef.current = manager;
    return () => {
      release();
      managerRef.current = null;
    };
  }, [open, dialogRef, overlayRef, fallbackId]);

  const refocus = useCallback(() => managerRef.current?.refocus(), []);
  return { refocus };
}
