"use client";

/*
 * The QR scanner as a modal on the Attendance page (/dashboard/attendance):
 * the existing QrScannerPanel (components/attendance/qr-scanner-panel.tsx)
 * with variant="modal", so there is ONE scanner implementation: the same
 * register load, QR window check, scan queue and API, camera controller,
 * decoder, audio / payment cues, results and cleanup. The browser stays on
 * the Attendance page; the standalone route /dashboard/attendance/[id]/scan
 * is unchanged.
 *
 * Lifecycle: the parent renders this only while open (keyed per opening),
 * so every opening mounts a fresh panel with a new camera controller (no
 * stopped stream is ever reused) and closing unmounts it: the panel's
 * cleanup disposes the camera (every MediaStreamTrack stopped), the decoder
 * loop, the queue, the refresher and its listeners. The camera starts only
 * from Start camera. Close (button, Escape) goes through the panel's own
 * close request, so scans still being sent ask first, as on the page.
 *
 * Layout: full screen on phones (safe areas respected, header and close
 * button always reachable, no horizontal scrolling); most of the screen on
 * tablets; a centred dialog up to 960 px wide and 90vh tall on desktops,
 * scrolling inside.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef } from "react";
import { Loader2, QrCode, X } from "lucide-react";

import { TAKE_ATTENDANCE_BUTTON_ID } from "@/components/attendance/attendance-lecture-dialog";
import { useModalDialog } from "@/components/attendance/use-modal-dialog";

const QrScannerPanel = dynamic(() => import("@/components/attendance/qr-scanner-panel").then((mod) => mod.QrScannerPanel), {
  ssr: false,
  loading: () => (
    <p role="status" className="flex items-center gap-2 p-4 text-sm text-slate-600">
      <Loader2 size={16} className="animate-spin text-[#112D5C]" aria-hidden />
      Loading the QR scanner…
    </p>
  ),
});

export const SCANNER_MODAL_TITLE_ID = "qr-scanner-modal-title";

/** The modal's responsive classes (exported for the layout tests). */
export const SCANNER_MODAL_CLASSES = {
  overlay: "fixed inset-0 z-50 flex items-stretch justify-center bg-slate-900/60 sm:items-center sm:p-4",
  dialog:
    "flex h-[100dvh] w-full min-w-0 flex-col overflow-hidden bg-slate-50 shadow-xl outline-none sm:h-auto sm:max-h-[94vh] sm:rounded-2xl lg:max-h-[90vh] lg:max-w-[960px]",
  header:
    "flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white pb-2 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] pt-[max(0.5rem,env(safe-area-inset-top))] sm:pt-2",
  body: "min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4 sm:pt-4",
  close: "inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100",
} as const;

export function QrScannerModal({ lectureId, className, onClose }: { lectureId: string; className: string | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  /** Set by the panel: its close request (asks first while scans are pending). */
  const closeRequestRef = useRef<(() => void) | null>(null);

  const requestClose = useCallback(() => {
    const request = closeRequestRef.current;
    if (request) request();
    else onClose(); // the panel is still loading: nothing to protect
  }, [onClose]);

  useModalDialog({ open: true, dialogRef, overlayRef, canClose: () => true, onClose: requestClose, fallbackId: TAKE_ATTENDANCE_BUTTON_ID });

  // The page behind does not scroll while the scanner is open (phones especially).
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div ref={overlayRef} data-dialog-overlay className={SCANNER_MODAL_CLASSES.overlay}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={SCANNER_MODAL_TITLE_ID} tabIndex={-1} className={SCANNER_MODAL_CLASSES.dialog}>
        <div className={SCANNER_MODAL_CLASSES.header}>
          <div className="min-w-0">
            <p id={SCANNER_MODAL_TITLE_ID} className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              <QrCode size={16} className="shrink-0 text-[#112D5C]" aria-hidden />
              QR attendance scanner
            </p>
            {className ? <p className="break-words text-xs text-slate-600">{className}</p> : null}
          </div>
          <button type="button" onClick={requestClose} aria-label="Close the QR scanner" data-autofocus className={SCANNER_MODAL_CLASSES.close}>
            <X size={22} aria-hidden />
          </button>
        </div>
        <div className={SCANNER_MODAL_CLASSES.body}>
          <QrScannerPanel lectureId={lectureId} variant="modal" className={className} onExit={onClose} closeRequestRef={closeRequestRef} />
        </div>
      </div>
    </div>
  );
}
