import dynamic from "next/dynamic";

const AdminTeacherMonitor = dynamic(
  () => import("@/components/admin-teacher-monitor").then((mod) => mod.AdminTeacherMonitor),
  {
    loading: () => <div className="text-sm text-slate-600">Loading admin tools...</div>,
  }
);

export default function AdminDashboardPage() {
  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-brand-200 bg-card p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-700">Admin Dashboard</p>
        <h1 className="mt-3 text-2xl font-semibold text-slate-900 sm:text-3xl">Teacher Activity and Class Enrollment</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600 sm:text-base">
          Monitor teachers who have logged in, drill into each teacher&apos;s classes, and view the number of students
          registered per class.
        </p>
      </section>

      <AdminTeacherMonitor />
    </div>
  );
}
