"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Maximize2, Radio, Video, X } from "lucide-react";

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
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
}

function formatStartTime(startedAt: string | null): string | null {
  if (!startedAt) return null;
  return new Date(startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function LiveBroadcastCard({
  broadcasts,
  heading = "Live on YouTube now",
  tone = "rose",
}: Props) {
  const [playing, setPlaying] = useState<LiveBroadcastView | null>(null);
  // Only compute the elapsed label after mount so SSR and the first client render agree.
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

  // Keep the player open only while its broadcast is still live.
  useEffect(() => {
    if (playing && !broadcasts.some((b) => b.id === playing.id)) {
      setPlaying(null);
    }
  }, [broadcasts, playing]);

  const broadcastsToShow = broadcasts;
  if (broadcastsToShow.length === 0) return null;

  return (
    <section
      className={`overflow-hidden rounded-2xl border-2 shadow-panel ${t.section}`}
    >
      <div
        className={`flex items-center gap-3 border-b px-4 py-4 sm:px-5 ${t.header}`}
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
            ({broadcastsToShow.length})
          </span>
        </h2>
      </div>

      <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-3">
        {broadcastsToShow.map((broadcast) => {
          const elapsed = mounted ? formatElapsed(broadcast.startedAt) : null;
          const startedClock = formatStartTime(broadcast.startedAt);
          return (
            <article
              key={broadcast.id}
              className={`overflow-hidden rounded-xl border bg-white p-4 shadow-card ${t.card}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className={`text-[11px] font-semibold uppercase tracking-wide opacity-70 ${t.title}`}>
                    Live streaming started
                  </p>
                  <p className={`mt-0.5 break-words font-bold sm:truncate ${t.title}`}>
                    {broadcast.className}
                  </p>
                  <p className="break-words text-xs text-muted sm:truncate">
                    Lecture: {broadcast.lectureTitle}
                  </p>
                </div>
                <span
                  className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${t.badge}`}
                >
                  LIVE
                </span>
              </div>

              <div className="mt-3 flex items-center gap-1.5 text-xs text-muted">
                <Radio size={13} className="flex-shrink-0" />
                <span>
                  {startedClock ? `Started ${startedClock}` : "Streaming"}
                  {elapsed ? ` · ${elapsed}` : ""}
                </span>
              </div>

              <button
                type="button"
                onClick={() => setPlaying(broadcast)}
                className={`mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold text-white transition ${t.button}`}
              >
                <Video size={12} /> Watch
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
        <LivePlayerModal broadcast={playing} onClose={() => setPlaying(null)} />
      ) : null}
    </section>
  );
}

function LivePlayerModal({
  broadcast,
  onClose,
}: {
  broadcast: LiveBroadcastView;
  onClose: () => void;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);

  function goFullscreen() {
    const el = frameRef.current;
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => undefined);
  }

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-black/70" onClick={onClose} aria-hidden />
      <div className="fixed inset-0 z-[71] flex items-center justify-center p-4">
        <div
          className="w-full max-w-3xl overflow-hidden rounded-xl border border-slate-200 bg-black shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3 border-b border-white/10 px-4 py-2.5">
            <p className="flex min-w-0 items-start gap-1.5 text-xs font-medium text-white">
              <Radio size={13} className="mt-0.5 flex-shrink-0" />
              <span className="break-words sm:truncate">
                {broadcast.className} · {broadcast.lectureTitle}
              </span>
            </p>
            <div className="flex flex-shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={goFullscreen}
                title="Fullscreen"
                className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-white/80 transition hover:bg-white/10 hover:text-white"
              >
                <Maximize2 size={13} /> Fullscreen
              </button>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div ref={frameRef} className="aspect-video w-full bg-black">
            <iframe
              key={broadcast.id}
              title={`${broadcast.className} — live`}
              src={`https://www.youtube.com/embed/${broadcast.videoId}?autoplay=1`}
              className="h-full w-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
              allowFullScreen
            />
          </div>
        </div>
      </div>
    </>
  );
}
