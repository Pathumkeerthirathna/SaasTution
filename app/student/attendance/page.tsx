import { historySeed, mapAttendanceTone } from "@/components/student-portal/student-data";
import { Panel, StatusBadge } from "@/components/student-portal/student-ui";

export default function StudentAttendancePage() {
  return (
    <Panel title="Attendance / History" subtitle="Review your attended sessions and status.">
      <div className="space-y-3">
        {historySeed.map((item) => (
          <article key={`${item.className}-${item.date}`} className="rounded-xl border border-brand-200 bg-white p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="font-medium text-slate-900">{item.className}</h3>
                <p className="mt-1 text-sm text-slate-600">{item.date}</p>
              </div>
              <StatusBadge label={item.status} tone={mapAttendanceTone(item.status)} />
            </div>
          </article>
        ))}
      </div>
    </Panel>
  );
}
