"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Radio, Video, X } from "lucide-react";

import type { LiveBroadcastView } from "@/lib/youtube-live-status";

type Tone = "rose" | "emerald";

type Props = {
  broadcasts: LiveBroadcastView[];
  heading?: string;
  tone?: Tone;
};

const TONES: Record<
  Tone,
  {
    section: string;
    header: string;
    dotPing: string;
    dot: string;
    title: string;
    card: string;
    badge: string;
    button: string;
  }
> = {
  rose: {
    section: "border-rose-400 bg-rose-50",
    header: "border-rose-200 bg-rose-100",
    dotPing: "bg-rose-500",
    dot: "bg-rose-600",
    title: "text-rose-900",
    card: "border-rose-200",
    badge: "bg-rose-100 text-rose-700",
    button: "bg-rose-600 hover:bg-rose-700",
  },
  emerald: {
    section: "border-emerald-400 bg-emerald-50",
    header: "border-emerald-200 bg-emerald-100",
    dotPing: "bg-emerald-400",
    dot: "bg-emerald-500",
    title: "text-emerald-900",
    card: "border-emerald-200",
    badge: "bg-emerald-100 text-emerald-700",
    button: "bg-emerald-600 hover:bg-emerald-700",
  },
};

function formatElapsed(startedAt: string | null): string | null {
  if (!startedAt) return null;
  const mins = Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function LiveBroadcastCard({
  broadcasts,
  heading = "Live on YouTube now",
  tone = "rose",
}: Props) {
  const [playing, setPlaying] = useState<LiveBroadcastView | null>(null);
  // Only compute the "Streaming Nm" elapsed label after mount so SSR and the
  // first client render agree.
  const [mounted, setMounted] = useState(false);
  const t = TONES[tone];

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!playing) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setPlaying(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing]);

  if (broadcasts.length === 0) return null;

  return (
    <section
      className={`overflow-hidden rounded-2xl border-2 shadow-panel ${t.section}`}
    >
      <div
        className={`flex items-center gap-3 border-b px-5 py-4 ${t.header}`}
      >
        <span className="relative flex h-3 w-3">
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${t.dotPing}`}
          />
          <span
            className={`relative inline-flex h-3 w-3 rounded-full ${t.dot}`}
          />
        </span>
        <h2 className={`font-bold ${t.title}`}>
          {heading}
          <span className="ml-2 font-semibold opacity-70">
            ({broadcasts.length})
          </span>
        </h2>
      </div>

      <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3">
        {broadcasts.map((broadcast) => {
          const elapsed = mounted ? formatElapsed(broadcast.startedAt) : null;
          return (
            <article
              key={broadcast.id}
              className={`overflow-hidden rounded-xl border bg-white p-4 shadow-card ${t.card}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className={`truncate font-bold ${t.title}`}>
                    {broadcast.className}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {broadcast.lectureTitle}
                  </p>
                </div>
                <span
                  className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${t.badge}`}
                >
                  LIVE
                </span>
              </div>

              <div className="mt-3 flex items-center gap-1.5 text-sm text-muted">
                <Radio size={13} />
                <span>{elapsed ? `Streaming ${elapsed}` : "Streaming"}</span>
              </div>

              <button
                type="button"
                onClick={() => setPlaying(broadcast)}
                className={`mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold text-white transition ${t.button}`}
              >
                <Video size={12} /> View Live
              </button>

              <a
                href={broadcast.youtubeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 flex items-center justify-center gap-1 text-[11px] font-medium text-muted transition hover:text-foreground"
              >
                <ExternalLink size={11} /> Open on YouTube
              </a>
            </article>
          );
        })}
      </div>

      {playing ? (
        <>
          <div
            className="fixed inset-0 z-[70] bg-black/70"
            onClick={() => setPlaying(null)}
            aria-hidden
          />
          <div className="fixed inset-0 z-[71] flex items-center justify-center p-4">
            <div
              className="w-full max-w-3xl rounded-xl border border-slate-200 bg-black shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
                <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-white">
                  <Radio size={13} className="flex-shrink-0" />
                  <span className="truncate">
                    {playing.className} · {playing.lectureTitle}
                  </span>
                </p>
                <button
                  type="button"
                  onClick={() => setPlaying(null)}
                  className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white"
                >
                  <X size={14} />
                </button>
              </div>

              <div className="aspect-video w-full">
                <iframe
                  key={playing.id}
                  title={`${playing.className} — live`}
                  src={`https://www.youtube.com/embed/${playing.videoId}?autoplay=1`}
                  className="h-full w-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
