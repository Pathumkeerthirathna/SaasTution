import Link from "next/link";

import { ongoingClassesSeed } from "@/components/student-portal/student-data";
import { Panel, StatusBadge } from "@/components/student-portal/student-ui";

export default function StudentLiveClassesPage() {
  return (
    <Panel title="Live Classes" subtitle="Classes currently active and available to join.">
      <div className="grid gap-4 lg:grid-cols-2">
        {ongoingClassesSeed.map((item) => (
          <article key={`${item.className}-${item.time}`} className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900">{item.className}</h3>
                <p className="mt-1 text-sm text-slate-600">Teacher: {item.teacherName}</p>
                <p className="text-sm text-slate-600">{item.time}</p>
              </div>
              <StatusBadge label={item.status} tone="live" />
            </div>
            <div className="mt-4">
              <Link href={item.joinLink} className="inline-flex rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white">
                Join Now
              </Link>
            </div>
          </article>
        ))}
      </div>
    </Panel>
  );
}
