"use client";

import { ReactNode } from "react";
import { BookOpen, CalendarDays, ClipboardList, HelpCircle, Radio, type LucideIcon } from "lucide-react";

type SummaryCardProps = {
  title: string;
  value: string;
  helper: string;
  icon?: "book" | "calendar" | "radio" | "assignment" | "quiz";
  color?: "blue" | "violet" | "emerald" | "amber" | "rose" | "sky";
};

type PanelProps = {
  id?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  contentClassName?: string;
  children: ReactNode;
};

const colorMap = {
  blue:    { bg: "bg-brand-50",   icon: "bg-brand-100 text-brand-600",   value: "text-brand-700",  border: "border-brand-200"  },
  violet:  { bg: "bg-violet-50",  icon: "bg-violet-100 text-violet-600", value: "text-violet-700", border: "border-violet-200" },
  emerald: { bg: "bg-emerald-50", icon: "bg-emerald-100 text-emerald-600",value: "text-emerald-700",border: "border-emerald-200"},
  amber:   { bg: "bg-amber-50",   icon: "bg-amber-100 text-amber-600",   value: "text-amber-700",  border: "border-amber-200"  },
  rose:    { bg: "bg-rose-50",    icon: "bg-rose-100 text-rose-600",     value: "text-rose-700",   border: "border-rose-200"   },
  sky:     { bg: "bg-sky-50",     icon: "bg-sky-100 text-sky-600",       value: "text-sky-700",    border: "border-sky-200"    },
} as const;

const summaryIconMap: Record<NonNullable<SummaryCardProps["icon"]>, LucideIcon> = {
  book: BookOpen,
  calendar: CalendarDays,
  radio: Radio,
  assignment: ClipboardList,
  quiz: HelpCircle,
};

export function SummaryCard({ title, value, helper, icon, color = "blue" }: SummaryCardProps) {
  const c = colorMap[color];
  const Icon = icon ? summaryIconMap[icon] : null;
  return (
    <article className={`relative overflow-hidden rounded-2xl border ${c.border} ${c.bg} p-5 shadow-card`}>
      {/* Subtle background circle decoration */}
      <div className="pointer-events-none absolute -right-4 -top-4 h-20 w-20 rounded-full opacity-20" style={{ background: "currentColor" }} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-widest text-muted">{title}</p>
          <p className={`mt-2 text-3xl font-bold leading-none ${c.value}`}>{value}</p>
          <p className="mt-2 text-xs text-muted">{helper}</p>
        </div>
        {Icon && (
          <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${c.icon}`}>
            <Icon size={20} />
          </div>
        )}
      </div>
    </article>
  );
}

export function Panel({ id, title, subtitle, actions, contentClassName, children }: PanelProps) {
  return (
    <section id={id} className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
      <header className="flex flex-col gap-3 border-b border-brand-100 bg-gradient-to-r from-brand-50 to-white px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-5">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-foreground sm:text-xl">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className={contentClassName ?? "p-4 sm:p-6"}>{children}</div>
    </section>
  );
}

export function StatusBadge({
  label,
  tone,
}: {
  label: string;
  tone: "live" | "pending" | "completed" | "overdue" | "neutral";
}) {
  const toneClasses = {
    live:      "border-emerald-200 bg-emerald-50 text-emerald-700",
    pending:   "border-amber-200  bg-amber-50  text-amber-700",
    completed: "border-indigo-200 bg-indigo-50 text-indigo-700",
    overdue:   "border-rose-200   bg-rose-50   text-rose-700",
    neutral:   "border-slate-200  bg-slate-50  text-slate-600",
  } as const;

  const dot = {
    live:      "bg-emerald-500",
    pending:   "bg-amber-500",
    completed: "bg-indigo-500",
    overdue:   "bg-rose-500",
    neutral:   "bg-slate-400",
  } as const;

  return (
    <span className={`status-pill ${toneClasses[tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot[tone]}`} />
      {label}
    </span>
  );
}

