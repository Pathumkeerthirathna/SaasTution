"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CalendarClock,
  ClipboardList,
  DollarSign,
  GraduationCap,
  Package,
  UserCheck,
} from "lucide-react";

type RangeKey = "month" | "week" | "quarter" | "year";

type Metrics = {
  payments: { due: number; total: number; dueAmountLkr: number };
  lectures: { scheduled: number; total: number };
  events: { pending: number; total: number };
  schedules: { pending: number; total: number };
  materials: { pendingToSend: number; total: number };
};

type Props = {
  studentsPending: number;
  studentsTotal: number;
};

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "month", label: "This month" },
  { key: "week", label: "This week" },
  { key: "quarter", label: "This quarter" },
  { key: "year", label: "This year" },
];

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function rangeToDates(range: RangeKey): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  if (range === "week") {
    const start = new Date(now);
    start.setDate(now.getDate() - now.getDay()); // Sunday
    const end = new Date(start);
    end.setDate(start.getDate() + 6); // Saturday
    return { from: fmtDate(start), to: fmtDate(end) };
  }

  if (range === "quarter") {
    const qStartMonth = Math.floor(m / 3) * 3;
    return {
      from: fmtDate(new Date(y, qStartMonth, 1)),
      to: fmtDate(new Date(y, qStartMonth + 3, 0)),
    };
  }

  if (range === "year") {
    return { from: fmtDate(new Date(y, 0, 1)), to: fmtDate(new Date(y, 11, 31)) };
  }

  // month
  return {
    from: fmtDate(new Date(y, m, 1)),
    to: fmtDate(new Date(y, m + 1, 0)),
  };
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

export function DashboardMetricCards({ studentsPending, studentsTotal }: Props) {
  const [range, setRange] = useState<RangeKey>("month");
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { from, to } = useMemo(() => rangeToDates(range), [range]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch(`/api/dashboard/metrics?from=${from}&to=${to}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (res) => {
        const body = (await res.json()) as {
          success: boolean;
          data?: Metrics;
          error?: { message?: string };
        };
        if (!res.ok || !body.success || !body.data) {
          throw new Error(body.error?.message ?? "Failed to load metrics.");
        }
        setMetrics(body.data);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load metrics.");
      })
      .finally(() => {
        setLoading(false);
      });

    return () => controller.abort();
  }, [from, to]);

  const dateCards: {
    key: string;
    label: string;
    href: string;
    icon: typeof GraduationCap;
    pending: number | null;
    total: number | null;
    sub?: string | null;
    tone: string;
  }[] = [
    {
      key: "payments",
      label: "Payments due",
      href: "/dashboard/classes",
      icon: DollarSign,
      pending: metrics?.payments.due ?? null,
      total: metrics?.payments.total ?? null,
      sub:
        metrics != null
          ? `LKR ${formatNumber(metrics.payments.dueAmountLkr)} due`
          : null,
      tone: "text-rose-700",
    },
    {
      key: "lectures",
      label: "Lectures scheduled",
      href: "/dashboard/lectures",
      icon: GraduationCap,
      pending: metrics?.lectures.scheduled ?? null,
      total: metrics?.lectures.total ?? null,
      tone: "text-violet-700",
    },
    {
      key: "events",
      label: "Events pending",
      href: "/dashboard/calendar",
      icon: CalendarClock,
      pending: metrics?.events.pending ?? null,
      total: metrics?.events.total ?? null,
      tone: "text-sky-700",
    },
    {
      key: "schedules",
      label: "Schedules to do",
      href: "/dashboard/classes",
      icon: ClipboardList,
      pending: metrics?.schedules.pending ?? null,
      total: metrics?.schedules.total ?? null,
      tone: "text-amber-700",
    },
    {
      key: "materials",
      label: "Tutes & papers to send",
      href: "/dashboard/material-bundles",
      icon: Package,
      pending: metrics?.materials.pendingToSend ?? null,
      total: metrics?.materials.total ?? null,
      tone: "text-emerald-700",
    },
  ];

  return (
    <section className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
      <div className="flex flex-col gap-3 border-b border-brand-100 bg-gradient-to-r from-brand-50 to-white px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-bold text-foreground">Workload overview</h2>
          <p className="mt-0.5 text-xs text-muted">
            Pending vs total across your classes
          </p>
        </div>
        <div className="flex flex-wrap gap-1 rounded-xl border border-brand-100 bg-brand-50/60 p-1">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setRange(opt.key)}
              className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
                range === opt.key
                  ? "bg-brand-700 text-white shadow-soft"
                  : "text-brand-700 hover:bg-brand-100"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 p-5 md:grid-cols-3 xl:grid-cols-6">
        {/* Students — never affected by the range */}
        <Link
          href="/dashboard/students"
          className="rounded-xl border border-brand-100 bg-brand-50/40 p-4 transition hover:border-brand-300 hover:bg-brand-50"
        >
          <div className="flex items-center gap-1.5 text-muted">
            <UserCheck size={13} />
            <p className="text-[11px] font-bold uppercase tracking-wide">
              Pending students
            </p>
          </div>
          <p className="mt-2 text-2xl font-bold text-brand-700">
            {formatNumber(studentsPending)}
            <span className="ml-1 text-sm font-semibold text-muted">
              / {formatNumber(studentsTotal)}
            </span>
          </p>
          <p className="mt-1 text-[11px] text-muted">Awaiting confirmation</p>
        </Link>

        {dateCards.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.key}
              href={card.href}
              className="rounded-xl border border-brand-100 bg-brand-50/40 p-4 transition hover:border-brand-300 hover:bg-brand-50"
            >
              <div className="flex items-center gap-1.5 text-muted">
                <Icon size={13} />
                <p className="text-[11px] font-bold uppercase tracking-wide">
                  {card.label}
                </p>
              </div>
              {error ? (
                <p className="mt-2 text-xs font-medium text-rose-600">—</p>
              ) : loading || card.pending === null ? (
                <div className="mt-2 h-7 w-16 animate-pulse rounded bg-brand-100" />
              ) : (
                <p className={`mt-2 text-2xl font-bold ${card.tone}`}>
                  {formatNumber(card.pending)}
                  <span className="ml-1 text-sm font-semibold text-muted">
                    / {formatNumber(card.total ?? 0)}
                  </span>
                </p>
              )}
              <p className="mt-1 text-[11px] text-muted">
                {error
                  ? "Couldn't load"
                  : loading || card.sub === undefined
                    ? " "
                    : (card.sub ?? " ")}
              </p>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
