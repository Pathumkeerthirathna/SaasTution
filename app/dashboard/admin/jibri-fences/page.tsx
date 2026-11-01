import dynamic from "next/dynamic";

const AdminJibriFences = dynamic(
  () => import("@/components/admin-jibri-fences").then((mod) => mod.AdminJibriFences),
  {
    loading: () => <div className="text-sm text-slate-600">Loading Jibri shutdown status...</div>,
  }
);

export default function AdminJibriFencesPage() {
  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-brand-200 bg-card p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-700">Admin Dashboard</p>
        <h1 className="mt-3 text-2xl font-semibold text-slate-900 sm:text-3xl">Classroom stream shutdown</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600 sm:text-base">
          The shutdown worker&apos;s health, the shared mode, and the teachers who cannot start Recording or Live until an
          earlier classroom stream is confirmed stopped.
        </p>
      </section>

      <AdminJibriFences />
    </div>
  );
}
