import dynamic from "next/dynamic";

import { requireTeacherSession } from "@/lib/auth-session";

const TeacherCalendarPanel = dynamic(
  () =>
    import("@/components/teacher-calendar-panel").then(
      (mod) => mod.TeacherCalendarPanel
    ),
  {
    loading: () => (
      <div className="mt-6 text-sm text-muted">Loading calendar...</div>
    ),
  }
);

export default async function TeacherCalendarPage() {
  await requireTeacherSession();

  return (
    <div className="flex w-full flex-1 flex-col pb-2">
      <TeacherCalendarPanel />
    </div>
  );
}
