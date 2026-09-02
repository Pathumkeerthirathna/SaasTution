"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BookMarked,
  CalendarClock,
  ScrollText,
  ClipboardList,
  HelpCircle,
  Wallet,
  Hourglass,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";

type CountdownKind =
  | "LECTURE"
  | "SCHEDULE"
  | "PAPER"
  | "CLASS_PAPER"
  | "ASSIGNMENT"
  | "QUIZ"
  | "PAYMENT";

type CountdownItem = {
  id: string;
  kind: CountdownKind;
  message: string;
  title: string;
  subtitle: string;
  startsAt: string;
  href: string;
};

const KIND_STYLE: Record<CountdownKind, { icon: LucideIcon; chip: string }> = {
  LECTURE:     { icon: BookMarked,    chip: "bg-emerald-100 text-emerald-700" },
  SCHEDULE:    { icon: CalendarClock, chip: "bg-amber-100 text-amber-700" },
  PAPER:       { icon: ScrollText,    chip: "bg-violet-100 text-violet-700" },
  CLASS_PAPER: { icon: ScrollText,    chip: "bg-violet-100 text-violet-700" },
  ASSIGNMENT:  { icon: ClipboardList, chip: "bg-sky-100 text-sky-700" },
  QUIZ:        { icon: HelpCircle,    chip: "bg-indigo-100 text-indigo-700" },
  PAYMENT:     { icon: Wallet,        chip: "bg-teal-100 text-teal-700" },
};

function formatHms(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function DashboardCountdowns({ items }: { items: CountdownItem[] }) {
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const live = useMemo(() => {
    if (nowMs === null) return [];
    return items
      .map((item) => ({ item, remaining: new Date(item.startsAt).getTime() - nowMs }))
      .filter(({ remaining }) => remaining > 0)
      .sort((a, b) => a.remaining - b.remaining);
  }, [items, nowMs]);

  if (nowMs === null || live.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-3xl border border-border bg-white shadow-card">
      <div className="flex items-center gap-2 border-b border-brand-100 bg-gradient-to-r from-emerald-50 to-white px-5 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
          <Hourglass size={14} />
        </span>
        <div>
          <h2 className="text-sm font-bold text-foreground">Starting soon</h2>
          <p className="text-[11px] text-muted">Everything due or starting in the next 8 hours</p>
        </div>
      </div>

      <ul className="divide-y divide-brand-50">
        {live.map(({ item, remaining }) => {
            const style = KIND_STYLE[item.kind];
            const Icon = style.icon;
            const urgent = remaining < 60 * 60 * 1000;

            return (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-brand-50/50"
                >
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${style.chip}`}>
                    <Icon size={15} />
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">
                      <span className="font-normal text-muted">{item.message} </span>
                      {item.title}
                    </p>
                    <p className="truncate text-[11px] text-muted">{item.subtitle}</p>
                  </div>

                  <span
                    className={`shrink-0 rounded-lg px-2 py-1 text-sm font-bold tabular-nums ${
                      urgent ? "bg-rose-50 text-rose-600" : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    {formatHms(remaining)}
                  </span>

                  <ChevronRight size={14} className="shrink-0 text-slate-300" />
                </Link>
              </li>
            );
        })}
      </ul>
    </section>
  );
}
