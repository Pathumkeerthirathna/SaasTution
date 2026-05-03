import { lecturesSeed } from "@/components/student-portal/student-data";
import { Panel } from "@/components/student-portal/student-ui";

export default function StudentLecturesPage() {
  return (
    <Panel title="Lectures / Notes" subtitle="Materials uploaded by your teachers.">
      <div className="space-y-3">
        {lecturesSeed.map((item) => (
          <article key={item.title} className="flex items-center justify-between rounded-xl border border-brand-200 bg-white p-3">
            <div>
              <h3 className="font-medium text-slate-900">{item.title}</h3>
              <p className="mt-1 text-sm text-slate-600">Type: {item.type}</p>
            </div>
            <button
              type="button"
              className="rounded-xl border border-brand-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-brand-50"
            >
              {item.actionLabel}
            </button>
          </article>
        ))}
      </div>
    </Panel>
  );
}
