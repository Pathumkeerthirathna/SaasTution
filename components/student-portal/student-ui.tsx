"use client";

import { ReactNode } from "react";

type SummaryCardProps = {
  title: string;
  value: string;
  helper: string;
};

type PanelProps = {
  id?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function SummaryCard({ title, value, helper }: SummaryCardProps) {
  return (
    <article className="rounded-2xl border border-brand-200 bg-card p-4 shadow-sm sm:p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">{title}</p>
      <p className="mt-3 text-2xl font-semibold text-slate-900 sm:text-3xl">{value}</p>
      <p className="mt-2 text-sm text-slate-600">{helper}</p>
    </article>
  );
}

export function Panel({ id, title, subtitle, actions, children }: PanelProps) {
  return (
    <section id={id} className="rounded-3xl border border-brand-200 bg-card p-5 shadow-sm sm:p-6">
      <header className="flex flex-col gap-3 border-b border-brand-200 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm text-slate-600">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function StatusBadge({ label, tone }: { label: string; tone: "live" | "pending" | "completed" | "overdue" | "neutral" }) {
  const toneClasses = {
    live: "border-emerald-200 bg-emerald-50 text-emerald-700",
    pending: "border-amber-200 bg-amber-50 text-amber-700",
    completed: "border-blue-200 bg-blue-50 text-blue-700",
    overdue: "border-red-200 bg-red-50 text-red-700",
    neutral: "border-slate-200 bg-slate-50 text-slate-700",
  } as const;

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${toneClasses[tone]}`}>
      {label}
    </span>
  );
}
