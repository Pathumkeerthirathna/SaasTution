import dynamic from "next/dynamic";

const ClassManagementPanel = dynamic(() => import("@/components/class-management-panel").then((mod) => mod.ClassManagementPanel), {
  loading: () => <div className="mt-6 text-sm text-muted">Loading class management...</div>,
});

const TeacherClassPaymentsPanel = dynamic(
  () => import("@/components/teacher-class-payments-panel").then((mod) => mod.TeacherClassPaymentsPanel),
  {
    loading: () => <div className="mt-6 text-sm text-muted">Loading class payments...</div>,
  }
);

export default function TeacherClassesPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col pb-2">
      <ClassManagementPanel />
      <TeacherClassPaymentsPanel />
    </div>
  );
}
