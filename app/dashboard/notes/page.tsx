import dynamic from "next/dynamic";
import { Suspense } from "react";

const TeacherNotesWorkspace = dynamic(() => import("@/components/notes/teacher-notes-workspace").then((mod) => mod.TeacherNotesWorkspace), {
  loading: () => <div className="mt-6 text-sm text-muted">Loading notes...</div>,
});

/**
 * The teacher's Notes page: a class's General Notes and its lectures' notes
 * (components/notes/teacher-notes-workspace.tsx). The dashboard layout and
 * middleware require a signed-in teacher; the APIs return only that teacher's
 * classes, lectures and notes.
 */
export default function TeacherNotesPage() {
  return (
    <div className="flex w-full flex-1 flex-col pb-2">
      <Suspense fallback={<div className="mt-6 text-sm text-muted">Loading notes...</div>}>
        <TeacherNotesWorkspace />
      </Suspense>
    </div>
  );
}
