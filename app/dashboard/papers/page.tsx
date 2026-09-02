import dynamic from "next/dynamic";

import { requireTeacherSession } from "@/lib/auth-session";

const ClassPapersPanel = dynamic(
  () => import("@/components/class-papers-panel").then((mod) => mod.ClassPapersPanel),
  { loading: () => <div className="mt-4 text-xs text-slate-400">Loading papers…</div> }
);

export default async function TeacherPapersPage() {
  await requireTeacherSession();

  return (
    <div className="flex w-full flex-1 flex-col pb-2">
      <ClassPapersPanel />
    </div>
  );
}
