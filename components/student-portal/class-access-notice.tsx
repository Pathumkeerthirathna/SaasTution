import Link from "next/link";
import { Lock } from "lucide-react";

import { formatStoredSriLankaDate } from "@/lib/time";

/*
 * Payment-due access restrictions of the logged-in student (from
 * getClassAccessRestrictions in services/class-access-service.ts), one card
 * per restricted class. Shown on every student page; the payment pages and
 * the rest of the account stay available.
 */

export type ClassAccessNoticeItem = {
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
      {groupRestrictionsByClass(restrictions).map((group) => (
        <section
          key={group.classId}
          className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-900"
        >
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <Lock size={14} className="shrink-0" aria-hidden="true" />
            <span className="break-words">{group.className}: class access paused</span>
          </p>
          <p className="mt-1 text-rose-800">
            Lectures, notes, recordings, quizzes, papers and the live classroom of this class are unavailable because a
            class fee is unpaid after its due date and grace period. Your other classes are not affected.
          </p>
          <ul className="mt-1.5 space-y-1">
            {group.fees.map((fee) => (
              <li key={fee.feeId} className="rounded-lg border border-rose-100 bg-white/70 px-2 py-1.5">
                <span className="font-semibold">
                  {MONTHS[fee.month - 1] ?? fee.month} {fee.year}
                </span>
                {" · "}Outstanding Rs. {fee.outstandingAmount.toLocaleString()}
                {" · "}Due {formatStoredSriLankaDate(fee.dueDate)}
                {" · "}Grace period ({fee.gracePeriodDays} day{fee.gracePeriodDays === 1 ? "" : "s"}) ended{" "}
                {formatStoredSriLankaDate(fee.graceEndsAt)}
              </li>
            ))}
          </ul>
          <p className="mt-1.5">
            To restore access, pay the fee and submit your payment slip.{" "}
            <Link
              href={`/student/payments?classId=${encodeURIComponent(group.classId)}`}
              className="font-semibold text-rose-900 underline underline-offset-2"
            >
              Go to Payments
            </Link>
            . Access returns as soon as a slip is submitted.
          </p>
        </section>
      ))}
    </div>
  );
}
