import Link from "next/link";
import dynamic from "next/dynamic";

const StudentGuardianManagementPanel = dynamic(
  () => import("@/components/student-guardian-management-panel").then((mod) => mod.StudentGuardianManagementPanel),
  {
    loading: () => <div className="mt-6 text-sm text-muted">Loading student management...</div>,
  }
);

export default function StudentManagementPage() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col py-2">
      <div className="rounded-3xl border border-black/10 bg-card p-6 shadow-sm dark:border-white/10 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Student & Guardian Management</p>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">Manage students, class assignment, and guardians</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted sm:text-base">
          Add students, assign them to your classes, create guardian profiles, and track enrolled students with
          pagination.
        </p>
        <div className="mt-4">
          <Link
            href="/dashboard"
            className="inline-flex rounded-xl border border-black/10 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
          >
            Back to dashboard
          </Link>
        </div>
      </div>

      <StudentGuardianManagementPanel />
    </div>
  );
}
