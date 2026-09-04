"use client";

import { useEffect, useMemo, useState } from "react";

type CountdownItem = {
  itemId: string;
  itemTitle: string;
  className: string;
  bundleTitle: string;
  paperStartAt: string;
};

type PaperCountdownListProps = {
  items: CountdownItem[];
};

function formatDuration(ms: number) {
  if (ms <= 0) return "00:00:00";

  const totalSeconds = Math.floor(ms / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");

  return `${hours}:${minutes}:${seconds}`;
}

export function PaperCountdownList({ items }: PaperCountdownListProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  const activeItems = useMemo(
    () =>
      items
        .map((item) => ({
          ...item,
          remainingMs: new Date(item.paperStartAt).getTime() - now,
        }))
        .filter((item) => item.remainingMs > 0)
        .sort((a, b) => a.remainingMs - b.remainingMs)
        .slice(0, 5),
    [items, now],
  );

  if (activeItems.length === 0) {
    return null;
  }

  return (
    <section className="rounded-3xl border border-amber-200 bg-amber-50/60 p-4 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900">Paper countdown</h2>
        <span className="rounded-full bg-amber-200 px-2.5 py-1 text-xs font-semibold text-amber-800">
          Starting soon
        </span>
      </div>
      <p className="mt-1 text-sm text-slate-600">These papers are about to begin based on your teacher settings.</p>

      <div className="mt-4 space-y-2">
        {activeItems.map((item) => (
          <article key={item.itemId} className="rounded-xl border border-amber-200 bg-white p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">{item.itemTitle}</p>
                <p className="text-xs text-slate-600">{item.className} • {item.bundleTitle}</p>
              </div>
              <p className="shrink-0 rounded-lg bg-slate-900 px-2.5 py-1 text-sm font-semibold tabular-nums text-white">
                {formatDuration(item.remainingMs)}
              </p>
            </div>
            <p className="mt-1 text-xs text-slate-500">Starts at {new Date(item.paperStartAt).toLocaleString()}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
