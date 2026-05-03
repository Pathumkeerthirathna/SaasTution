import { mapQuizTone, quizzesSeed } from "@/components/student-portal/student-data";
import { Panel, StatusBadge } from "@/components/student-portal/student-ui";

export default function StudentQuizzesPage() {
  return (
    <Panel title="Quizzes" subtitle="Check quiz availability and complete on time.">
      <div className="space-y-3">
        {quizzesSeed.map((item) => (
          <article key={`${item.title}-${item.className}`} className="rounded-xl border border-brand-200 bg-white p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-medium text-slate-900">{item.title}</h3>
                <p className="mt-1 text-sm text-slate-600">{item.className}</p>
              </div>
              <StatusBadge label={item.availability} tone={mapQuizTone(item.availability)} />
            </div>
          </article>
        ))}
      </div>
    </Panel>
  );
}
