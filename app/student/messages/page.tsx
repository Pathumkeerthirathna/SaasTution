import { announcementsSeed } from "@/components/student-portal/student-data";
import { Panel } from "@/components/student-portal/student-ui";

export default function StudentMessagesPage() {
  return (
    <Panel title="Messages / Announcements" subtitle="Recent updates from teachers and classes.">
      <div className="space-y-3">
        {announcementsSeed.map((item) => (
          <article key={`${item.title}-${item.sentAt}`} className="rounded-xl border border-brand-200 bg-white p-3">
            <h3 className="font-medium text-slate-900">{item.title}</h3>
            <p className="mt-1 text-sm text-slate-600">From: {item.from}</p>
            <p className="mt-1 text-sm text-slate-700">{item.content}</p>
            <p className="mt-2 text-xs font-medium uppercase tracking-[0.12em] text-muted">{item.sentAt}</p>
          </article>
        ))}
      </div>
    </Panel>
  );
}
