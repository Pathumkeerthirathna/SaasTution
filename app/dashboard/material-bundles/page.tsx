import dynamic from "next/dynamic";

const MaterialBundlePanel = dynamic(
  () => import("@/components/material-bundle-panel").then((mod) => mod.MaterialBundlePanel),
  {
    loading: () => <div className="mt-6 text-sm text-muted">Loading monthly bundle management...</div>,
  }
);

export default function TeacherMaterialBundlesPage() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col pb-2">
      <MaterialBundlePanel />
    </div>
  );
}
