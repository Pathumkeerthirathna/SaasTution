import dynamic from "next/dynamic";

import { requireTeacherSession } from "@/lib/auth-session";

const ClassFeeSheetPanel = dynamic(
  () =>
    import("@/components/class-fee-sheet-panel").then(
      (mod) => mod.ClassFeeSheetPanel
    ),
  {
    loading: () => (
      <div className="mt-6 text-sm text-muted">Loading fee sheet...</div>
    ),
  }
);

export default async function TeacherPaymentsPage() {
  // Teacher-only page.
  await requireTeacherSession();

  return (
    <div className="flex w-full flex-1 flex-col pb-2">
      <ClassFeeSheetPanel />
    </div>
  );
}
