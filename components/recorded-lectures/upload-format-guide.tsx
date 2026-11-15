"use client";

import { useId, useState } from "react";
import { ChevronDown, CircleHelp, ExternalLink, ShieldCheck } from "lucide-react";

/*
 * Teacher help: the video format recorded lectures accept and how to convert
 * a video with HandBrake (a free desktop app). Information only: it changes
 * nothing about validation, the accepted format or the size limit (the limit
 * shown is the server's configured value, passed in by the page).
 *
 * Collapsed by default; a real <button> with aria-expanded / aria-controls
 * toggles the panel.
 */

export const HANDBRAKE_URL = "https://handbrake.fr/";

export const HANDBRAKE_STEPS: readonly string[] = [
  "Open HandBrake.",
  "Select the original video.",
  "Under Summary, set Format to MP4.",
  "Under Video, select H.264 (x264).",
  "Under Audio, select AAC.",
  "Choose where to save the converted file.",
  "Click Start Encode.",
  "Upload the converted MP4 to SLClassroom.",
];

export function UploadFormatGuide({ maxSizeLabel }: { maxSizeLabel: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="mt-3 rounded-xl border border-brand-100 bg-brand-50/40">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-xl px-3 text-left text-sm font-semibold text-brand-700 hover:bg-brand-50"
      >
        <span className="inline-flex items-center gap-2">
          <CircleHelp size={16} aria-hidden />
          Video format &amp; conversion guide
        </span>
        <ChevronDown size={16} aria-hidden className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      <div id={panelId} hidden={!open} className="space-y-4 border-t border-brand-100 px-3 pb-4 pt-3 text-xs text-slate-700">
        <section aria-labelledby={`${panelId}-format`}>
          <h3 id={`${panelId}-format`} className="text-xs font-bold text-slate-900">
            Supported format
          </h3>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Container", "MP4"],
              ["Video codec", "H.264 (AVC)"],
              ["Audio codec", "AAC"],
              ["Maximum size", `${maxSizeLabel} per part`],
            ].map(([term, value]) => (
              <div key={term} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{term}</dt>
                <dd className="mt-0.5 break-words text-sm font-semibold text-slate-900">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2">If your video is not supported, convert it to the recommended format before uploading.</p>
        </section>

        <section aria-labelledby={`${panelId}-handbrake`}>
          <h3 id={`${panelId}-handbrake`} className="text-xs font-bold text-slate-900">
            Convert a video with HandBrake
          </h3>
          <p className="mt-1">
            HandBrake is a free video converter for Windows, macOS and Linux.{" "}
            <a
              href={HANDBRAKE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-brand-700 underline underline-offset-2"
            >
              Download HandBrake from handbrake.fr
              <ExternalLink size={12} aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            {HANDBRAKE_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="mt-2 text-slate-600">
            Converting can take a while. How long depends on the size of the original video, the speed of your computer and the quality you
            choose.
          </p>
        </section>

        <p className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
          <ShieldCheck size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">Privacy: </span>
            convert classroom recordings on your own computer with HandBrake. Avoid uploading private classroom recordings to unknown online
            conversion websites.
          </span>
        </p>
      </div>
    </div>
  );
}
