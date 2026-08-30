import dynamic from "next/dynamic";

const MaterialBundlePanel = dynamic(
  () => import("@/components/material-bundle-panel").then((mod) => mod.MaterialBundlePanel),
  {
    loading: () => <div className="mt-4 text-xs text-slate-400">Loading monthly materials…</div>,
  }
);

export default function TeacherMaterialBundlesPage() {
  return (
    <div className="flex w-full flex-1 flex-col pb-2">
      <MaterialBundlePanel />
    </div>
  );
}
