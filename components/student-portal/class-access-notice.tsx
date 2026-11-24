import Link from "next/link";
import { Lock } from "lucide-react";

import { formatStoredSriLankaDate } from "@/lib/time";

/*
 * Payment-due access restrictions of the logged-in student (from
 * getClassAccessRestrictions in services/class-access-service.ts), one card
 * per restricted class. Shown on every student page; the payment pages and
 * the rest of the account stay available.
 *
 * Two reasons: OVERDUE (the due date + grace rule; the original text) and
 * INITIAL_PAYMENT (a public registration's first payment, which only a
 * payment the teacher has confirmed lifts). A missing reason is OVERDUE.
 *
 * This class-level notice covers the class ACTIVITIES (quizzes, assignments,
 * paper submissions, attendance, the live classroom). Resources are locked
 * per billing month instead: ResourceAccessNotice below, from the same
 * server-side resolver that the resource routes enforce
 * (services/resource-access-service.ts).
 */

export type ClassAccessNoticeItem = {
  reason?: "OVERDUE" | "INITIAL_PAYMENT";
  classId: string;
  className: string;
  feeId: string;
  year: number;
  month: number;
  outstandingAmount: number;
  dueDate: string;
  graceEndsAt: string;
  gracePeriodDays: number;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Restrictions grouped per class, in their original (oldest month first) order. */
export function groupRestrictionsByClass(items: readonly ClassAccessNoticeItem[]) {
  const groups = new Map<string, { classId: string; className: string; fees: ClassAccessNoticeItem[] }>();
  for (const item of items) {
    const group = groups.get(item.classId) ?? { classId: item.classId, className: item.className, fees: [] };
    group.fees.push(item);
    groups.set(item.classId, group);
  }
  return [...groups.values()];
}

export function ClassAccessNotice({ restrictions }: { restrictions: readonly ClassAccessNoticeItem[] }) {
  if (restrictions.length === 0) return null;

  return (
    <div className="mb-3 space-y-2" role="alert">
      {groupRestrictionsByClass(restrictions).map((group) => {
        const initial = group.fees.some((fee) => fee.reason === "INITIAL_PAYMENT");
        return (
        <section
          key={group.classId}
          data-restriction-reason={initial ? "INITIAL_PAYMENT" : "OVERDUE"}
          className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-900"
        >
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <Lock size={14} className="shrink-0" aria-hidden="true" />
            <span className="break-words">
              {group.className}: {initial ? "first payment required" : "class access paused"}
            </span>
          </p>
          {initial ? (
            <p className="mt-1 text-rose-800">
              Quizzes, assignments, paper submissions and the live classroom of this class open once your first class
              fee payment is confirmed by your teacher. Your other classes are not affected.
            </p>
          ) : (
            <p className="mt-1 text-rose-800">
              Quizzes, assignments, paper submissions and the live classroom of this class are unavailable because a
              class fee is unpaid after its due date and grace period. Your other classes are not affected.
            </p>
          )}
          <ul className="mt-1.5 space-y-1">
            {group.fees.map((fee) =>
              fee.reason === "INITIAL_PAYMENT" ? (
                <li key={fee.feeId} className="rounded-lg border border-rose-100 bg-white/70 px-2 py-1.5">
                  <span className="font-semibold">
                    {MONTHS[fee.month - 1] ?? fee.month} {fee.year}
                  </span>
                  {" · "}First payment
                  {" · "}Outstanding Rs. {fee.outstandingAmount.toLocaleString()}
                </li>
              ) : (
              <li key={fee.feeId} className="rounded-lg border border-rose-100 bg-white/70 px-2 py-1.5">
                <span className="font-semibold">
                  {MONTHS[fee.month - 1] ?? fee.month} {fee.year}
                </span>
                {" · "}Outstanding Rs. {fee.outstandingAmount.toLocaleString()}
                {" · "}Due {formatStoredSriLankaDate(fee.dueDate)}
                {" · "}Grace period ({fee.gracePeriodDays} day{fee.gracePeriodDays === 1 ? "" : "s"}) ended{" "}
                {formatStoredSriLankaDate(fee.graceEndsAt)}
              </li>
              )
            )}
          </ul>
          <p className="mt-1.5">
            To restore access, pay the fee and submit your payment slip.{" "}
            <Link
              href={`/student/payments?classId=${encodeURIComponent(group.classId)}`}
              className="font-semibold text-rose-900 underline underline-offset-2"
            >
              Go to Payments
            </Link>
            {initial
              ? ". Access opens once your teacher confirms the payment (a submitted slip awaits confirmation)."
              : ". Access returns as soon as a slip is submitted."}
          </p>
        </section>
        );
      })}
    </div>
  );
}

// ---- Monthly resource access ---------------------------------------------------------------

/** One class / billing month the student should know about (ResourceAccessNoticeItem in services/resource-access-service.ts). */
export type ResourceAccessNoticeMonth = {
  classId: string;
  className: string;
  year: number;
  month: number;
  locked: boolean;
  source: string;
  paymentStatus: string | null;
  outstandingAmount: number;
  dueDate: string | null;
  graceEndsAt: string | null;
  graceActive: boolean;
  gracePeriodDays: number;
};

const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function resourceMonthLabel(item: { year: number; month: number }) {
  return `${FULL_MONTHS[item.month - 1] ?? item.month} ${item.year}`;
}

function resourceMonthDetail(item: ResourceAccessNoticeMonth): string {
  const days = `${item.gracePeriodDays} day${item.gracePeriodDays === 1 ? "" : "s"}`;
  const outstanding = `Outstanding Rs. ${item.outstandingAmount.toLocaleString()}`;
  if (item.source === "OVERRIDE_REVOKED") return "Locked by your teacher";
  if (item.source === "INITIAL_PAYMENT") return `First payment · ${outstanding} · Opens once your teacher confirms the payment`;
  if (!item.locked) {
    return `${outstanding} · Grace period (${days}) active until ${item.graceEndsAt ? formatStoredSriLankaDate(item.graceEndsAt) : "-"} · Resources stay open until then`;
  }
  const status = item.paymentStatus === "PARTIAL" ? "Partly paid" : item.paymentStatus === "PENDING" ? "Slip awaiting confirmation" : "Unpaid";
  return `${status} · ${outstanding} · Grace period (${days}) ended ${item.graceEndsAt ? formatStoredSriLankaDate(item.graceEndsAt) : "-"}`;
}

/**
 * Locked (and soon-to-lock) resource months, one card per class. Paid months
 * never appear: the items come from the same resolver that the resource
 * routes enforce.
 */
export function ResourceAccessNotice({ months }: { months: readonly ResourceAccessNoticeMonth[] }) {
  if (months.length === 0) return null;
  const groups = new Map<string, { classId: string; className: string; months: ResourceAccessNoticeMonth[] }>();
  for (const item of months) {
    const group = groups.get(item.classId) ?? { classId: item.classId, className: item.className, months: [] };
    group.months.push(item);
    groups.set(item.classId, group);
  }

  return (
    <div className="mb-3 space-y-2" role="status" data-resource-access-notice>
      {[...groups.values()].map((group) => {
        const locked = group.months.filter((m) => m.locked);
        return (
          <section
            key={group.classId}
            data-resource-class={group.classId}
            className={`rounded-xl border px-3 py-2.5 text-xs ${locked.length > 0 ? "border-amber-300 bg-amber-50 text-amber-950" : "border-sky-200 bg-sky-50 text-sky-950"}`}
          >
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <Lock size={14} className="shrink-0" aria-hidden="true" />
              <span className="break-words">
                {group.className}:{" "}
                {locked.length > 0
                  ? `resources locked for ${locked.map(resourceMonthLabel).join(", ")}`
                  : "payment due, resources still open"}
              </span>
            </p>
            <p className="mt-1">
              Recordings, notes, papers, bundle files and whiteboards uploaded in a locked month stay locked until that
              month is paid and confirmed. Resources of your paid months and of your other classes are not affected.
            </p>
            <ul className="mt-1.5 space-y-1">
              {group.months.map((item) => (
                <li
                  key={`${item.year}-${item.month}`}
                  data-resource-month={`${item.year}-${String(item.month).padStart(2, "0")}`}
                  data-locked={item.locked ? "true" : "false"}
                  className="rounded-lg border border-white/60 bg-white/70 px-2 py-1.5"
                >
                  <span className="font-semibold">{resourceMonthLabel(item)}</span>
                  {" · "}
                  {item.locked ? "Locked" : "Open"}
                  {" · "}
                  {resourceMonthDetail(item)}
                </li>
              ))}
            </ul>
            <p className="mt-1.5">
              <Link
                href={`/student/payments?classId=${encodeURIComponent(group.classId)}`}
                className="font-semibold underline underline-offset-2"
              >
                Go to Payments
              </Link>
              . A submitted slip does not unlock resources: they open once your teacher confirms the payment.
            </p>
          </section>
        );
      })}
    </div>
  );
}
