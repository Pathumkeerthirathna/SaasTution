/*
 * The register's QR attendance section (Stages 5.7b-3d / 5.7b-3e): the QR
 * state from the loaded register's `qr` field, the "Scan QR codes" link
 * while scanning is available, and the "Close QR attendance" action while
 * the backend allows a closure. Display only: the server decides on every
 * scan and on the closure. Imports only pure logic (no camera code, no
 * decoder).
 *
 * The persisted `qr.closed` is the only source of "closed": a CLOSED
 * window without it (a cancelled or historical lecture, a missing setting)
 * is shown as unavailable, never as closed. Closing QR attendance and
 * finalizing the register are separate: both states are shown.
 */

import Link from "next/link";
import { Ban, CheckCircle2, Clock, Lock, LockOpen, QrCode, ShieldAlert } from "lucide-react";

import { formatColomboDateTime, type AttendanceRegisterResponse } from "@/components/attendance/attendance-ui";
import { scannerAvailability, scannerPath } from "@/components/attendance/qr-scanner-logic";

export const QR_SECTION_ID = "attendance-qr-section";
export const QR_CLOSE_ACTION_ID = "attendance-qr-close";

export type QrStatusState = "OPEN" | "NOT_OPEN" | "CLOSED" | "CANCELLED" | "HISTORICAL" | "UNAVAILABLE";
export type QrStatusSummary = { state: QrStatusState; label: string; detail: string };

/** The QR state shown on the register (Asia/Colombo times). */
export function qrStatusSummary(register: AttendanceRegisterResponse): QrStatusSummary {
  const qr = (register as Partial<AttendanceRegisterResponse>).qr;
  if (!qr) return { state: "UNAVAILABLE", label: "Not available", detail: "QR attendance is not available for this lecture on this server." };
  if (qr.closed) {
    return {
      state: "CLOSED",
      label: "Closed",
      detail: `QR attendance was closed${qr.closedAt ? ` on ${formatColomboDateTime(qr.closedAt)}` : ""}. No more QR scans are accepted. Attendance already recorded is kept.`,
    };
  }
  if (register.lecture.classStatus === "CANCELLED") {
    return { state: "CANCELLED", label: "Not available", detail: "This lecture is cancelled, so QR attendance is not taken and cannot be closed." };
  }
  const availability = scannerAvailability(register);
  if (availability.available) {
    return { state: "OPEN", label: "Open", detail: "Scanning is open: scan students' QR codes with a camera or a handheld scanner until you close QR attendance." };
  }
  if (availability.reason === "NOT_OPEN") {
    return { state: "NOT_OPEN", label: "Not open yet", detail: `Scanning opens at ${formatColomboDateTime(qr.opensAt)}, 30 minutes before the scheduled start.` };
  }
  if (availability.reason === "HISTORICAL") return { state: "HISTORICAL", label: "Not available", detail: availability.message };
  return { state: "UNAVAILABLE", label: "Not available", detail: availability.message };
}

export type QrClosureAvailability = { allowed: true; reason: null } | { allowed: false; reason: "NO_QR_STATE" | "ALREADY_CLOSED" | "CANCELLED" };

/**
 * Whether "Close QR attendance" is offered: whenever the closure is not
 * persisted yet and the lecture is not cancelled (the backend refuses
 * that). Deliberately NOT hidden for a window that has not opened yet or a
 * finalized register: the backend allows both.
 */
export function qrClosureAvailability(register: AttendanceRegisterResponse): QrClosureAvailability {
  const qr = (register as Partial<AttendanceRegisterResponse>).qr;
  if (!qr) return { allowed: false, reason: "NO_QR_STATE" };
  if (qr.closed) return { allowed: false, reason: "ALREADY_CLOSED" };
  if (register.lecture.classStatus === "CANCELLED") return { allowed: false, reason: "CANCELLED" };
  return { allowed: true, reason: null };
}

function StatusIcon({ state }: { state: QrStatusState }) {
  const props = { size: 14, "aria-hidden": true } as const;
  if (state === "OPEN") return <CheckCircle2 {...props} />;
  if (state === "NOT_OPEN") return <Clock {...props} />;
  if (state === "CLOSED") return <Lock {...props} />;
  if (state === "CANCELLED") return <Ban {...props} />;
  return <ShieldAlert {...props} />;
}

export function QrScanEntry({ register, onCloseQr }: { register: AttendanceRegisterResponse; onCloseQr?: () => void }) {
  const status = qrStatusSummary(register);
  const scanning = scannerAvailability(register);
  const closure = qrClosureAvailability(register);
  const finalized = register.register.finalized;
  return (
    <section
      id={QR_SECTION_ID}
      tabIndex={-1}
      aria-labelledby="attendance-qr-heading"
      className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm outline-none"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <QrCode size={18} className="mt-0.5 shrink-0 text-[#112D5C]" aria-hidden />
          <div className="min-w-0">
            <h2 id="attendance-qr-heading" className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
              QR attendance
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-800 ring-1 ring-slate-200">
                <StatusIcon state={status.state} />
                {`QR scanning: ${status.label}`}
              </span>
            </h2>
            <p className="mt-1 text-sm text-slate-700">{status.detail}</p>
            <p className="mt-1 flex items-center gap-1 text-xs text-slate-600">
              {finalized ? <Lock size={12} aria-hidden /> : <LockOpen size={12} aria-hidden />}
              {`Attendance register: ${finalized ? "finalized" : "not finalized"}. Closing QR attendance and finalizing the register are separate steps.`}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {scanning.available ? (
            <Link
              href={scannerPath(register.lecture.id)}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-[#112D5C] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
            >
              <QrCode size={15} aria-hidden />
              Scan QR codes
            </Link>
          ) : null}
          {closure.allowed && onCloseQr ? (
            <button
              type="button"
              id={QR_CLOSE_ACTION_ID}
              onClick={onCloseQr}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-800 hover:bg-rose-50"
            >
              <Lock size={15} aria-hidden />
              Close QR attendance
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
