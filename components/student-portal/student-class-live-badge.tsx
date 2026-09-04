"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Radio, Play, X, UserRound } from "lucide-react";

type StudentClassLiveBadgeProps = {
  className: string;
  teacherName: string;
  lectureTitle: string | null;
  startedAtISO: string;
  joinHref: string;
};

function formatElapsed(startedAt: Date): string {
  const mins = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function StudentClassLiveBadge({
  className,
  teacherName,
  lectureTitle,
  startedAtISO,
  joinHref,
}: StudentClassLiveBadgeProps) {
  const [open, setOpen] = useState(false);
  const [joining, setJoining] = useState(false);
  const [elapsed, setElapsed] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const router = useRouter();

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setElapsed(formatElapsed(new Date(startedAtISO)));
    const timer = setInterval(() => setElapsed(formatElapsed(new Date(startedAtISO))), 30_000);
    return () => clearInterval(timer);
  }, [startedAtISO]);

  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setCoords({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="absolute right-2.5 top-2.5 z-20 inline-flex items-center gap-1 rounded-full border border-white/30 bg-rose-600/90 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm backdrop-blur transition hover:bg-rose-600"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
        </span>
        Live
      </button>

      {open && mounted &&
        createPortal(
          <>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-40 cursor-default"
            />
            <div
              role="dialog"
              className="fixed z-50 w-[min(16rem,calc(100vw-1rem))] rounded-xl border border-slate-200 bg-white p-3 text-left text-slate-900 shadow-xl"
              style={{ top: coords?.top ?? -9999, right: coords?.right ?? 8 }}
            >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-rose-100 text-rose-600">
                  <Radio size={13} />
                </span>
                <p className="text-xs font-bold uppercase tracking-wide text-rose-600">Live now</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-slate-600"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>

            <p className="mt-2 text-sm font-semibold text-slate-900">{lectureTitle || className}</p>
            {lectureTitle && <p className="text-xs text-slate-500">{className}</p>}
            <p className="mt-1 flex items-center gap-1 text-[11px] text-slate-500">
              <UserRound size={11} />
              {teacherName}
            </p>
            {elapsed && <p className="mt-0.5 text-[11px] text-slate-400">Started {elapsed} ago</p>}

            <button
              type="button"
              disabled={joining}
              onClick={() => {
                setJoining(true);
                router.push(joinHref);
              }}
              className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
            >
              <Play size={13} />
              {joining ? "Joining…" : "Join class"}
            </button>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
