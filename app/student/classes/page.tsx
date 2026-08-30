import { Panel, StatusBadge } from "@/components/student-portal/student-ui";
import { StudentClassPaymentsPanel } from "@/components/student-portal/student-class-payments-panel";
import { requireStudentSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";
import { formatStoredSriLankaDateTime } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function StudentClassesPage() {
  const studentSession = await requireStudentSession();

  const enrollments = await prisma.classStudent.findMany({
    where: {
      studentId: studentSession.studentId,
    },
    orderBy: {
      assignedAt: "desc",
    },
    select: {
      id: true,
      isActive: true,
      assignedAt: true,
      removedAt: true,
      removeReason: true,
      class: {
        select: {
          id: true,
          name: true,
          description: true,
          schedule: true,
          monthlyFee: true,
          paymentDueWeek: true,
          teacher: {
            select: {
              name: true,
            },
          },
          schedules: {
            select: {
              dayOfWeek: true,
              startTime: true,
              endTime: true,
            },
            orderBy: {
              dayOfWeek: "asc",
            },
          },
        },
      },
    },
  });

  const activeEnrollments = enrollments.filter((enrollment) => enrollment.isActive);
  const pastEnrollments = enrollments.filter((enrollment) => !enrollment.isActive);

  const classesForPayments = activeEnrollments.map((enrollment) => ({
    id: enrollment.class.id,
    name: enrollment.class.name,
    monthlyFee: enrollment.class.monthlyFee,
    paymentDueWeek: enrollment.class.paymentDueWeek,
    teacherName: enrollment.class.teacher.name,
  }));

  return (
    <>
      <Panel title="My Classes" subtitle="Track active and past class enrollments with full assignment logs.">
        {enrollments.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-brand-200 bg-white/70 p-6 text-sm text-slate-600">
            You are not enrolled in any classes yet.
          </div>
        ) : (
          <div className="space-y-6">
            <section>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Active Classes ({activeEnrollments.length})</h3>
              {activeEnrollments.length === 0 ? (
                <p className="mt-2 text-sm text-slate-600">No active classes right now.</p>
              ) : (
                <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {activeEnrollments.map((enrollment) => (
                    <article key={enrollment.id} className="rounded-2xl border border-brand-200 bg-white p-4">
                      <h3 className="text-base font-semibold text-slate-900">{enrollment.class.name}</h3>
                      <p className="mt-1 text-sm text-slate-600">Teacher: {enrollment.class.teacher.name}</p>
                      <p className="text-sm text-slate-600">{enrollment.class.schedule}</p>
                      <p className="mt-1 text-sm font-semibold text-brand-700">Monthly fee: Rs {enrollment.class.monthlyFee.toLocaleString()}</p>
                      <p className="mt-1 text-xs text-slate-500">Payment due week: Week {enrollment.class.paymentDueWeek}</p>
                      <p className="mt-1 text-xs text-slate-500">Joined: {formatStoredSriLankaDateTime(enrollment.assignedAt)}</p>
                      {enrollment.class.description ? (
                        <p className="mt-1 text-sm text-slate-500 line-clamp-2">{enrollment.class.description}</p>
                      ) : null}
                      <div className="mt-3">
                        <StatusBadge label="Enrolled" tone="completed" />
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Past Classes ({pastEnrollments.length})</h3>
              {pastEnrollments.length === 0 ? (
                <p className="mt-2 text-sm text-slate-600">No past class records yet.</p>
              ) : (
                <div className="mt-3 space-y-3">
                  {pastEnrollments.map((enrollment) => (
                    <article key={enrollment.id} className="rounded-2xl border border-brand-200 bg-white p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <h4 className="text-base font-semibold text-slate-900">{enrollment.class.name}</h4>
                          <p className="text-sm text-slate-600">Teacher: {enrollment.class.teacher.name}</p>
                        </div>
                        <StatusBadge label="Past" tone="pending" />
                      </div>
                      <p className="mt-1 text-sm text-slate-600">{enrollment.class.schedule}</p>
                      <p className="mt-1 text-xs text-slate-500">Joined: {formatStoredSriLankaDateTime(enrollment.assignedAt)}</p>
                      <p className="mt-1 text-xs text-slate-500">Removed: {enrollment.removedAt ? formatStoredSriLankaDateTime(enrollment.removedAt) : "-"}</p>
                      {enrollment.removeReason ? <p className="mt-1 text-xs text-slate-500">Reason: {enrollment.removeReason}</p> : null}
                      <p className="mt-2 text-sm font-semibold text-brand-700">Monthly fee at class: Rs {enrollment.class.monthlyFee.toLocaleString()}</p>
                      <p className="mt-1 text-xs text-slate-500">Configured due week: Week {enrollment.class.paymentDueWeek}</p>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </Panel>

      {classesForPayments.length > 0 ? <StudentClassPaymentsPanel classes={classesForPayments} /> : null}
    </>
  );
}
