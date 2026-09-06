"use client";

import {
  CheckCircle2,
  CircleDashed,
  Wallet,
  CalendarClock,
} from "lucide-react";
import { useEffect, useState, useCallback } from "react";

import type { PaymentData } from "@/app/dashboard/students/[id]/page";
import { formatStoredSriLankaDate } from "@/lib/time";

interface StudentPaymentsProps {
  studentId: string;
  /** When provided by the parent page, the tab renders this instead of fetching. */
  data?: PaymentData | null;
}

function money(value: number) {
  return `Rs. ${value.toLocaleString()}`;
}

const EMPTY_SUMMARY: PaymentData["summary"] = {
  totalFees: 0,
  paidCount: 0,
  unpaidCount: 0,
  paidAmount: 0,
  unpaidAmount: 0,
  totalAmount: 0,
  paidPercent: 0,
};

export function StudentPayments({ studentId, data }: StudentPaymentsProps) {
  const controlled = data !== undefined;

  const [fetched, setFetched] = useState<PaymentData | null>(null);
  const [openClassId, setOpenClassId] = useState<string | null>(null);

  const loadPayments = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/student/Profile/${studentId}/payments`
      );
      const result = await response.json();

      setFetched(
        result.success
          ? (result.data as PaymentData)
          : { summary: EMPTY_SUMMARY, classes: [] }
      );
    } catch (error) {
      console.error(error);
      setFetched({ summary: EMPTY_SUMMARY, classes: [] });
    }
  }, [studentId]);

  useEffect(() => {
    if (controlled) return;
    void loadPayments();
  }, [controlled, loadPayments]);

  const resolved = controlled ? data : fetched;
  const loading = resolved == null;

  if (loading) {
    return (
      <div className="animate-pulse space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="h-24 rounded-xl bg-slate-100" />
          <div className="h-24 rounded-xl bg-slate-100" />
        </div>
        <div className="h-32 rounded-xl bg-slate-100" />
      </div>
    );
  }

  const { summary, classes } = resolved;

  return (
    <div className="space-y-4">
      {/* Done / Not done totals */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-4">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
              <CheckCircle2 size={13} />
              Paid
            </p>
            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
              {summary.paidCount} / {summary.totalFees}
            </span>
          </div>
          <p className="mt-2 text-lg font-bold text-emerald-700">
            {money(summary.paidAmount)}
          </p>
        </div>

        <div className="rounded-xl border border-rose-100 bg-rose-50/60 p-4">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-rose-700">
              <CircleDashed size={13} />
              Not paid
            </p>
            <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">
              {summary.unpaidCount} / {summary.totalFees}
            </span>
          </div>
          <p className="mt-2 text-lg font-bold text-rose-700">
            {money(summary.unpaidAmount)}
          </p>
        </div>
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex items-center justify-between text-[11px] font-medium text-slate-500">
          <span>
            {summary.paidPercent}% of {money(summary.totalAmount)} settled
          </span>
          <span>{money(summary.totalAmount)}</span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-teal-500 transition-all duration-700"
            style={{ width: `${summary.paidPercent}%` }}
          />
        </div>
      </div>

      {/* Per-class breakdown */}
      {classes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <Wallet className="mx-auto mb-2 h-8 w-8 text-slate-400" />
          <h3 className="text-[13px] font-semibold text-slate-900">
            No fee records
          </h3>
          <p className="mt-1 text-[12px] text-slate-500">
            Monthly fees appear here once the class runs a payment cycle.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {classes.map((item) => {
            const open = openClassId === item.classId;

            return (
              <div
                key={item.classId}
                className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
              >
                <button
                  type="button"
                  onClick={() =>
                    setOpenClassId(open ? null : item.classId)
                  }
                  className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
                >
                  <div className="min-w-0">
                    <p className="break-words text-[13px] font-semibold text-slate-900 sm:truncate">
                      {item.className}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Monthly fee {money(item.monthlyFee)}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                      {item.paidCount} paid
                    </span>
                    {item.unpaidCount > 0 && (
                      <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">
                        {item.unpaidCount} due
                      </span>
                    )}
                  </div>
                </button>

                {open && (
                  <div className="border-t border-slate-100">
                    {item.fees.length === 0 ? (
                      <p className="px-4 py-3 text-[11px] text-slate-400">
                        No fee rows for this class yet.
                      </p>
                    ) : (
                      <ul className="divide-y divide-slate-50">
                        {item.fees.map((fee) => (
                          <li
                            key={fee.id}
                            className="flex items-center justify-between gap-3 px-4 py-2"
                          >
                            <div className="min-w-0">
                              <p className="text-[12px] font-medium text-slate-700">
                                {fee.monthLabel}
                              </p>
                              {fee.dueDate && (
                                <p className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-400">
                                  <CalendarClock size={10} />
                                  Due {formatStoredSriLankaDate(fee.dueDate)}
                                </p>
                              )}
                            </div>

                            <div className="flex shrink-0 items-center gap-2">
                              <span className="text-[12px] font-semibold text-slate-900">
                                {money(fee.finalAmount)}
                              </span>
                              <span
                                className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                                  fee.paid
                                    ? "bg-emerald-100 text-emerald-700"
                                    : "bg-rose-100 text-rose-700"
                                }`}
                              >
                                {fee.paid ? (
                                  <CheckCircle2 size={10} />
                                ) : (
                                  <CircleDashed size={10} />
                                )}
                                {fee.paid
                                  ? "Paid"
                                  : fee.payment
                                  ? fee.payment.status
                                  : "Unpaid"}
                              </span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
