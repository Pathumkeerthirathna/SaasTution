import dynamic from "next/dynamic";
import { unstable_noStore as noStore } from "next/cache";
import { Suspense } from "react";

import { colomboMonthKey } from "@/components/attendance/attendance-month";

const AttendanceOverviewPanel = dynamic(
  () => import("@/components/attendance/attendance-overview-panel").then((mod) => mod.AttendanceOverviewPanel),
  { loading: () => <div className="mt-6 text-sm text-muted">Loading attendance...</div> }
);

/**
 * The teacher's attendance overview (read only). The dashboard layout and
 * middleware require a signed-in teacher; the API returns only that teacher's
 * lectures.
 *
 * The workspace's first month is the current Sri Lankan (Asia/Colombo)
 * month, computed here once per request and passed down, so the server
 * render and the client hydration use the same month.
 */
export default function AttendanceOverviewPage() {
  noStore(); // per request: never a month frozen at build time
  const initialMonth = colomboMonthKey(new Date());
  return (
    <div className="flex w-full flex-1 flex-col pb-2">
      <Suspense fallback={<div className="mt-6 text-sm text-muted">Loading attendance...</div>}>
        <AttendanceOverviewPanel initialMonth={initialMonth} />
      </Suspense>
    </div>
  );
}
