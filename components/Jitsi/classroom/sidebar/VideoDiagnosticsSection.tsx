"use client";

import { useId, useState } from "react";
import type { VideoTelemetryStatus } from "../../hooks/useJitsi";
import { diagnosticsSwitchStep, VIDEO_DIAGNOSTICS_CONFIRM } from "../../video-diagnostics-controls.mjs";
import {
  formatCaptureLine,
  formatMessagingLine,
  formatTrackLine,
  formatReceiveDetails,
  formatReceiveSummary,
  formatSendDetails,
  formatSendSummary,
} from "../../video-telemetry.mjs";

type VideoDiagnosticsSectionProps = {
  enabled: boolean;
  status: VideoTelemetryStatus | null;
  /** A reporting participant's name (from the authenticated participant map). */
  labelOf: (participantId: string) => string;
  onToggle: (enabled: boolean) => void;
  /** Copies the kept snapshots as JSON; resolves false when it could not. */
  onCopy?: () => Promise<boolean>;
};

/** What the diagnostics show before there is anything measured. */
function describeWaiting(status: VideoTelemetryStatus | null): string | null {
  if (!status) {
    return "Starting…";
  }

  if (!status.active) {
    return "Waiting for your teacher permissions…";
  }

  if (status.error === "no-peer-connection") {
    return "Not connected to the video bridge yet.";
  }

  if (status.error === "getstats-failed") {
    return "This browser did not return WebRTC stats this time.";
  }

  return null;
}

/**
 * The confirmation before diagnostics is turned on (inside the settings
 * menu, so answering it never counts as a click outside the menu).
 */
export function DiagnosticsConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const titleId = useId();
  const messageId = useId();

  return (
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      className="mx-1 mt-1 rounded-lg border border-[#334155] bg-[#0F172A] p-3"
    >
      <p id={titleId} className="text-sm font-semibold text-[#F8FAFC]">
        {VIDEO_DIAGNOSTICS_CONFIRM.title}
      </p>
      <p id={messageId} className="mt-1 text-[11px] leading-snug text-[#CBD5E1]">
        {VIDEO_DIAGNOSTICS_CONFIRM.message}
      </p>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-xs text-[#CBD5E1] ring-1 ring-[#334155] transition hover:bg-[#1E293B]"
        >
          {VIDEO_DIAGNOSTICS_CONFIRM.cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-lg bg-[#3B82F6] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#2563EB]"
        >
          {VIDEO_DIAGNOSTICS_CONFIRM.confirmLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * Teacher settings: read-only video diagnostics. Every number comes from
 * WebRTC stats (custom.js); anything not measured is shown as N/A. Every
 * line wraps, nothing is cut off.
 */
export default function VideoDiagnosticsSection({
  enabled,
  status,
  labelOf,
  onToggle,
  onCopy,
}: VideoDiagnosticsSectionProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  // Turning it on asks first (diagnosticsSwitchStep); nothing is sent or
  // polled until the teacher confirms.
  const [confirming, setConfirming] = useState(false);

  const step = (action: "switch" | "confirm" | "cancel") => {
    const next = diagnosticsSwitchStep({ enabled, confirming }, action);

    setConfirming(next.confirming);

    if (next.toggle !== null) {
      setCopyState("idle");
      onToggle(next.toggle);
    }
  };

  const waiting = enabled ? describeWaiting(status) : null;
  const send = status?.active ? status.send : null;
  const capture = formatCaptureLine(send);
  const details = formatSendDetails(send);
  const trackLine = formatTrackLine(send);
  const messagingLine = status?.active ? formatMessagingLine(status) : null;
  const silent = status?.active
    ? status.silent.map((participantId) => labelOf(participantId)).sort((a, b) => a.localeCompare(b))
    : [];
  const students = status?.active
    ? status.students
        .map((row) => ({ row, label: labelOf(row.participantId as string) }))
        .sort((a, b) => a.label.localeCompare(b.label))
    : [];

  return (
    <>
      <div className="my-3 h-px bg-[#1E293B]" />

      <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-[#94A3B8]">
        Video diagnostics
      </p>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => step("switch")}
        className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm text-[#CBD5E1] transition hover:bg-[#1E293B]"
      >
        <span className="text-left">
          <span className="block text-[#F8FAFC]">Measure video quality</span>
          <span className="block text-[10px] text-[#64748B]">
            What you really send and each student really receives (read-only, every 5 s)
          </span>
        </span>
        <span
          aria-hidden="true"
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
            enabled ? "bg-[#3B82F6]" : "bg-[#334155]"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              enabled ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </span>
      </button>

      {confirming && !enabled ? (
        <DiagnosticsConfirm onConfirm={() => step("confirm")} onCancel={() => step("cancel")} />
      ) : null}

      {enabled ? (
        <div role="status" className="mt-1 space-y-2 break-words px-3 text-[10px] leading-snug">
          {waiting ? (
            <p className="text-[#94A3B8]">{waiting}</p>
          ) : (
            <>
              <div className="space-y-0.5">
                <p className="text-[#F8FAFC]">{formatSendSummary(send)}</p>
                {capture ? <p className="text-[#94A3B8]">{capture}</p> : null}
                {trackLine ? <p className="text-[#94A3B8]">{trackLine}</p> : null}
                {details ? <p className="text-[#64748B]">{details}</p> : null}
              </div>

              <div className="space-y-1.5">
                <p className="text-[#94A3B8]">
                  {messagingLine ?? `Students reporting: ${students.length}`}
                  {students.length === 0 ? " (students start reporting within about 15 s)" : ""}
                </p>
                {silent.length ? (
                  <p className="text-[#FCD34D]">
                    Not reporting: {silent.join(", ")}. Their meeting page may run an older
                    custom.js (needs 1014), or the bridge channel is not delivering.
                  </p>
                ) : null}
                {students.map(({ row, label }) => {
                  const receiveDetails = formatReceiveDetails(row);

                  return (
                    <div key={row.participantId as string} className="space-y-0.5">
                      <p className={row.stale ? "text-[#94A3B8]" : "text-[#E2E8F0]"}>
                        {formatReceiveSummary(label, row)}
                      </p>
                      {receiveDetails ? <p className="text-[#64748B]">{receiveDetails}</p> : null}
                    </div>
                  );
                })}
              </div>

              <p className="text-[#64748B]">
                FPS: capture = frames from the camera; encoded = pictures sent (with AV1 / VP9
                layers, the browser&apos;s own count); decoded = frames a student&apos;s browser
                showed. N/A = not measured.
              </p>
            </>
          )}

          {onCopy ? (
            <button
              type="button"
              onClick={() => {
                void onCopy().then((copied) => setCopyState(copied ? "copied" : "failed"));
              }}
              className="w-full rounded-lg px-2 py-1.5 text-xs text-[#CBD5E1] ring-1 ring-[#334155] transition hover:bg-[#1E293B]"
            >
              {copyState === "copied"
                ? "Copied to clipboard"
                : copyState === "failed"
                  ? "Could not copy (clipboard blocked)"
                  : "Copy diagnostics (last 10 min, JSON)"}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
