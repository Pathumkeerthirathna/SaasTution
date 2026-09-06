import dynamic from "next/dynamic";

const AdminTeacherAccountsPanel = dynamic(
  () =>
    import("@/components/admin-teacher-accounts-panel").then(
      (mod) => mod.AdminTeacherAccountsPanel
    ),
  {
    loading: () => <div className="text-sm text-slate-600">Loading teacher accounts...</div>,
  }
);

export default function AdminTeacherAccountsPage() {
  return <AdminTeacherAccountsPanel />;
}
