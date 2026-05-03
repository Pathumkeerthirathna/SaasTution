import { ongoingClassesSeed, upcomingClassesSeed } from "@/components/student-portal/student-data";
import { Panel, StatusBadge } from "@/components/student-portal/student-ui";

export default function StudentClassesPage() {
  const classes = [...ongoingClassesSeed, ...upcomingClassesSeed];

  return (
    <Panel title="My Classes" subtitle="All classes you are currently enrolled in.">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {classes.map((item) => (
          <article key={`${item.className}-${item.teacherName}`} className="rounded-2xl border border-brand-200 bg-white p-4">
            <h3 className="text-base font-semibold text-slate-900">{item.className}</h3>
            <p className="mt-1 text-sm text-slate-600">Teacher: {item.teacherName}</p>
            <p className="text-sm text-slate-600">{"time" in item ? item.time : item.dateTime}</p>
            <div className="mt-3">
              {"status" in item ? <StatusBadge label={item.status} tone="live" /> : <StatusBadge label="Scheduled" tone="pending" />}
            </div>
          </article>
        ))}
      </div>
    </Panel>
  );
}
