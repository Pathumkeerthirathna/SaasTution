import dynamic from "next/dynamic";
import { Suspense } from "react";

const AttendanceOverviewPanel = dynamic(
  () => import("@/components/attendance/attendance-overview-panel").then((mod) => mod.AttendanceOverviewPanel),
  { loading: () => <div className="mt-6 text-sm text-muted">Loading attendance...</div> }
);

/**
 * The teacher's attendance overview (read only). The dashboard layout and
 * middleware require a signed-in teacher; the API returns only that teacher's
 * lectures.
 */
export default function AttendanceOverviewPage() {
  return (
    <div className="flex w-full flex-1 flex-col pb-2">
      <Suspense fallback={<div className="mt-6 text-sm text-muted">Loading attendance...</div>}>
        <AttendanceOverviewPanel />
      </Suspense>
    </div>
  );
}
