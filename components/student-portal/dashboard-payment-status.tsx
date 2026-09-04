"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Wallet,
  CalendarClock,
  Clock,
  AlertTriangle,
  ArrowUpRight,
  ArrowRight,
} from "lucide-react";

import { useStudentLiveEvent } from "@/components/student-portal/use-student-live-events";

const TO_PAY_HREF = "/student/payments?filter=toPay";

type FeeState = "UNPAID" | "ACTION_NEEDED" | "IN_REVIEW";

type Fee = {
  feeId: string;
  classId: string;
  className: string;
  year: number;
  month: number;
  finalAmount: number;
  dueDate: string | null;
  state: FeeState;
};

type Data = {
  due: Fee[];
  dueSoon: Fee[];
  dueTotal: number;
  dueSoonTotal: number;
};

const rs = (n: number) => `Rs ${n.toLocaleString()}`;

function monthLabel(year: number, month: number) {
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

function fmtDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const STATE_BADGE: Record<FeeState, { label: string; cls: string }> = {
  UNPAID: { label: "To pay", cls: "bg-amber-100 text-amber-700" },
  ACTION_NEEDED: { label: "Needs clarification", cls: "bg-rose-100 text-rose-700" },
  IN_REVIEW: { label: "Awaiting confirmation", cls: "bg-sky-100 text-sky-700" },
};

function FeeRow({ fee, overdue }: { fee: Fee; overdue: boolean }) {
  const badge = STATE_BADGE[fee.state];
  return (
    <li>
      <Link
        href={`/student/payments?classId=${fee.classId}&filter=toPay&focus=${fee.feeId}`}
        className={`flex items-start gap-3 rounded-lg border p-2.5 transition-colors hover:bg-emerald-50/40 ${
          overdue ? "border-rose-200" : "border-slate-200"
        }`}
      >
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
            overdue ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-600"
          }`}
        >
          <Wallet size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900 break-words sm:truncate">
            {fee.className}
            <span className="ml-1.5 font-normal text-slate-400">
              · {monthLabel(fee.year, fee.month)}
            </span>
          </p>
          <p className="mt-0.5 inline-flex flex-wrap items-center gap-1 text-[11px] font-medium">
            <CalendarClock size={10} className="text-slate-400" />
            <span className={overdue ? "text-rose-600" : "text-slate-500"}>
              Due {fmtDate(fee.dueDate)}
            </span>
            <span className="ml-1 text-slate-700">{rs(fee.finalAmount)}</span>
            <span
              className={`ml-1 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${badge.cls}`}
            >
              {fee.state === "ACTION_NEEDED" ? <AlertTriangle size={9} /> : null}
              {badge.label}
            </span>
          </p>
        </div>
        <ArrowUpRight size={13} className="mt-1 shrink-0 text-slate-300" />
      </Link>
    </li>
  );
}

export function DashboardPaymentStatus() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/student/dashboard/payments", { cache: "no-store" });
      const json = (await res.json()) as { success?: boolean; data?: Data };
      if (json.success && json.data) setData(json.data);
    } catch {
      /* keep last snapshot */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime: the shared student SSE stream signals payment/data changes.
  useStudentLiveEvent("counts-stale", () => void load());

  const due = data?.due ?? [];
  const dueSoon = data?.dueSoon ?? [];
  const nothing = !loading && due.length === 0 && dueSoon.length === 0;

  return (
    <section className="overflow-hidden rounded-3xl border border-border bg-white shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-100 bg-gradient-to-r from-emerald-50 to-white px-4 py-3 sm:px-5">
        <h2 className="inline-flex items-center gap-1.5 text-sm font-bold text-foreground">
          <Wallet size={14} className="text-emerald-600" />
          Payment status
        </h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href={TO_PAY_HREF}
            className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-0.5 text-[11px] font-bold text-rose-700 hover:bg-rose-200"
          >
            <AlertTriangle size={11} />
            {due.length} due
          </Link>
          <Link
            href={TO_PAY_HREF}
            className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold text-amber-700 hover:bg-amber-200"
          >
            <Clock size={11} />
            {dueSoon.length} due soon
          </Link>
          <Link
            href="/student/payments"
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
          >
            View all <ArrowRight size={12} />
          </Link>
        </div>
      </div>

      <div className="space-y-4 p-4">
        {/* Money due now vs due later this month */}
        <div className="grid gap-2 sm:grid-cols-2">
          <Link
            href={TO_PAY_HREF}
            className={`rounded-xl border p-3 transition-colors hover:border-emerald-300 ${
              (data?.dueTotal ?? 0) > 0 ? "border-rose-200 bg-rose-50/60" : "border-slate-200 bg-slate-50/70"
            }`}
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Due now</p>
            <p
              className={`mt-0.5 text-lg font-bold ${
                (data?.dueTotal ?? 0) > 0 ? "text-rose-700" : "text-slate-700"
              }`}
            >
              {rs(data?.dueTotal ?? 0)}
            </p>
            <p className="text-[10px] text-slate-400">Due date reached · not yet paid</p>
          </Link>
          <Link
            href={TO_PAY_HREF}
            className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 transition-colors hover:border-emerald-300"
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Pay ahead
            </p>
            <p className="mt-0.5 text-lg font-bold text-slate-700">{rs(data?.dueSoonTotal ?? 0)}</p>
            <p className="text-[10px] text-slate-400">Due later this month</p>
          </Link>
        </div>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : nothing ? (
          <p className="rounded-lg border border-dashed border-emerald-200 bg-emerald-50/60 p-5 text-center text-xs font-medium text-emerald-700">
            Nothing due — you&apos;re all caught up.
          </p>
        ) : (
          <div className="space-y-4">
            {due.length > 0 ? (
              <div>
                <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-rose-600">
                  Due now
                </p>
                <ul className="space-y-2">
                  {due.map((fee) => (
                    <FeeRow key={fee.feeId} fee={fee} overdue />
                  ))}
                </ul>
              </div>
            ) : null}
            {dueSoon.length > 0 ? (
              <div>
                <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-amber-600">
                  Due soon this month
                </p>
                <ul className="space-y-2">
                  {dueSoon.map((fee) => (
                    <FeeRow key={fee.feeId} fee={fee} overdue={false} />
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
