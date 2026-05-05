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
    <article className="surface-card p-5 sm:p-6">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">{title}</p>
      <p className="mt-3 text-3xl font-semibold text-slate-900 sm:text-[2rem]">{value}</p>
      <p className="mt-2 text-sm text-slate-600">{helper}</p>
    </article>
  );
}

export function Panel({ id, title, subtitle, actions, children }: PanelProps) {
  return (
    <section id={id} className="surface-panel p-6 sm:p-7">
      <header className="flex flex-col gap-3 border-b border-brand-200/80 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 sm:text-2xl">{title}</h2>
          {subtitle ? <p className="mt-1.5 text-sm text-slate-600">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function StatusBadge({ label, tone }: { label: string; tone: "live" | "pending" | "completed" | "overdue" | "neutral" }) {
  const toneClasses = {
    live: "border-emerald-200 bg-emerald-50 text-emerald-700",
    pending: "border-amber-200 bg-amber-50 text-amber-700",
    completed: "border-indigo-200 bg-indigo-50 text-indigo-700",
    overdue: "border-red-200 bg-red-50 text-red-700",
    neutral: "border-slate-200 bg-slate-50 text-slate-700",
  } as const;

  return <span className={`status-pill ${toneClasses[tone]}`}>{label}</span>;
}
