"use client";

import { useEffect, useRef, type MouseEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/*
 * Enlarged view of the student's own attendance QR ("My Attendance QR",
 * components/student-portal/student-qr-panel.tsx), so a teacher can scan it
 * from another device. Frontend only: it shows the SAME in-memory blob URL the
 * card already loaded (no new request, no new QR, nothing stored). The PNG is
 * 512 px and drawn with pixelated scaling, so the modules stay sharp.
 *
 * Modal dialog: role="dialog", aria-modal, titled and described; focus moves to
 * Close and stays inside; Escape, Close or a click outside the panel closes it;
 * focus returns to whatever opened it; the page behind does not scroll while
 * it is open (the previous inline styles are restored on close).
 */

export const QR_ENLARGE_TITLE_ID = "qr-enlarge-title";
export const QR_ENLARGE_DESCRIPTION_ID = "qr-enlarge-description";

type BodyLike = { style: { overflow: string; paddingRight: string } };

/**
 * Stops `body` scrolling (keeping the layout from shifting when a scrollbar
 * disappears) and returns the function that restores the previous inline values.
 */
export function lockBodyScroll(body: BodyLike, scrollbarWidth: number): () => void {
  const previous = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
  body.style.overflow = "hidden";
  if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
  return () => {
    body.style.overflow = previous.overflow;
    body.style.paddingRight = previous.paddingRight;
  };
}

/** What a key press inside the open dialog does. */
export function qrDialogKeyAction(key: string): "close" | "trap-focus" | null {
  if (key === "Escape" || key === "Esc") return "close";
  if (key === "Tab") return "trap-focus"; // Close is the only control: keep focus on it
  return null;
}

/** True only for a click on the backdrop itself, never inside the panel. */
export function isBackdropClick(target: EventTarget | null, currentTarget: EventTarget | null): boolean {
  return target !== null && target === currentTarget;
}

type QrEnlargeDialogViewProps = {
  imageUrl: string;
  studentName: string;
  registrationNumber: string | null;
  onClose: () => void;
  closeButtonRef?: RefObject<HTMLButtonElement>;
};

/** The dialog markup (no effects), rendered into a portal by QrEnlargeDialog. */
export function QrEnlargeDialogView({ imageUrl, studentName, registrationNumber, onClose, closeButtonRef }: QrEnlargeDialogViewProps) {
  const onBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (isBackdropClick(event.target, event.currentTarget)) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-slate-900/70 p-4"
      onClick={onBackdropClick}
      data-testid="qr-enlarge-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={QR_ENLARGE_TITLE_ID}
        aria-describedby={QR_ENLARGE_DESCRIPTION_ID}
        className="relative flex max-h-full w-full max-w-[640px] flex-col items-center gap-4 rounded-2xl bg-white p-4 shadow-xl sm:p-6"
      >
        <div className="flex w-full items-start justify-between gap-3">
          <h2 id={QR_ENLARGE_TITLE_ID} className="text-lg font-semibold text-slate-900">
            My Attendance QR
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close enlarged QR code"
            className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        {/* The same blob URL the card shows; 512 px PNG, scaled without smoothing. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt={`QR code for ${studentName}`}
          className="aspect-square w-[min(85vw,70vh,560px)] max-w-full rounded-xl border border-slate-200 bg-white object-contain p-2 [image-rendering:pixelated]"
          data-testid="qr-enlarge-image"
        />

        <div id={QR_ENLARGE_DESCRIPTION_ID} className="text-center">
          <p className="break-words font-semibold text-slate-900">{studentName}</p>
          <p className="break-words text-sm text-slate-600">
            {registrationNumber ? `Registration No: ${registrationNumber}` : "Registration number not assigned yet"}
          </p>
          <p className="mt-1 text-xs text-slate-500">Hold your screen up to your teacher&apos;s scanner.</p>
        </div>
      </div>
    </div>
  );
}

type QrEnlargeDialogProps = Omit<QrEnlargeDialogViewProps, "closeButtonRef">;

/** Mounted only while open (client side). */
export function QrEnlargeDialog(props: QrEnlargeDialogProps) {
  const { onClose } = props;
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unlock = lockBodyScroll(document.body, window.innerWidth - document.documentElement.clientWidth);
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      const action = qrDialogKeyAction(event.key);
      if (action === "close") {
        event.preventDefault();
        onCloseRef.current();
      } else if (action === "trap-focus") {
        event.preventDefault();
        closeButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      unlock();
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  return createPortal(<QrEnlargeDialogView {...props} closeButtonRef={closeButtonRef} />, document.body);
}
