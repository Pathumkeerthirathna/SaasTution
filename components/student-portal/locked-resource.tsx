import Link from "next/link";
import { Lock } from "lucide-react";

/*
 * A resource of a locked billing month (services/resource-access-service.ts),
 * shown in place of its view / download / play controls. The server never
 * sends such a resource's file or YouTube link, and its routes refuse it.
 */

export type ResourceLock = { locked: boolean; year: number; month: number };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function lockMonthLabel(lock: { year: number; month: number }) {
  return `${MONTHS[lock.month - 1] ?? lock.month} ${lock.year}`;
}

export function isResourceLocked(item: { access?: ResourceLock | null } | null | undefined): boolean {
  return Boolean(item?.access?.locked);
}

export function LockedResourceBadge({ lock, classId, compact = false }: { lock: ResourceLock; classId?: string; compact?: boolean }) {
  return (
    <span
      data-locked-resource={`${lock.year}-${String(lock.month).padStart(2, "0")}`}
      className="inline-flex flex-wrap items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900"
    >
      <Lock size={10} aria-hidden />
      {compact ? `Locked · ${lockMonthLabel(lock)}` : `Locked: payment required for ${lockMonthLabel(lock)}`}
      {classId && !compact ? (
        <Link href={`/student/payments?classId=${encodeURIComponent(classId)}`} className="underline underline-offset-2">
          Pay
        </Link>
      ) : null}
    </span>
  );
}
