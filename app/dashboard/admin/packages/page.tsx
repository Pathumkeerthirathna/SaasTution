import dynamic from "next/dynamic";

const AdminSubscriptionPlansPanel = dynamic(
  () =>
    import("@/components/admin-subscription-plans-panel").then(
      (mod) => mod.AdminSubscriptionPlansPanel
    ),
  {
    loading: () => <div className="text-sm text-slate-600">Loading packages...</div>,
  }
);

export default function AdminPackagesPage() {
  return <AdminSubscriptionPlansPanel />;
}
