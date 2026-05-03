import { assignmentsSeed, mapAssignmentTone } from "@/components/student-portal/student-data";
import { Panel, StatusBadge } from "@/components/student-portal/student-ui";

export default function StudentAssignmentsPage() {
  return (
    <Panel title="Assignments" subtitle="Track pending, completed, and overdue work.">
      <div className="space-y-3">
        {assignmentsSeed.map((item) => (
          <article key={`${item.title}-${item.className}`} className="rounded-xl border border-brand-200 bg-white p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-medium text-slate-900">{item.title}</h3>
                <p className="mt-1 text-sm text-slate-600">{item.className}</p>
                <p className="text-sm text-slate-600">Due: {item.dueDate}</p>
              </div>
              <StatusBadge label={item.status.toUpperCase()} tone={mapAssignmentTone(item.status)} />
            </div>
          </article>
        ))}
      </div>
    </Panel>
  );
}
