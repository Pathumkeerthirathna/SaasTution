import Link from "next/link";
import dynamic from "next/dynamic";

const TeacherSessionPanel = dynamic(() => import("@/components/teacher-session-panel").then((mod) => mod.TeacherSessionPanel), {
  loading: () => <div className="mt-6 text-sm text-muted">Loading live sessions...</div>,
});

export default function TeacherSessionsPage() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col py-2">
      <div className="rounded-3xl border border-black/10 bg-card p-6 shadow-sm dark:border-white/10 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Live Class Sessions</p>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">Start and manage Jitsi class meetings</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted sm:text-base">
          Start a unique room for each class, share student join links, and automatically capture join and leave
          attendance timestamps.
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

      <TeacherSessionPanel />
    </div>
  );
}
