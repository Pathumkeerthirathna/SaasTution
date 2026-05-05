import { Panel, StatusBadge } from "@/components/student-portal/student-ui";
import { requireStudentSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function StudentClassesPage() {
  const studentSession = await requireStudentSession();

  const enrollments = await prisma.classStudent.findMany({
    where: {
      studentId: studentSession.studentId,
      isActive: true,
    },
    orderBy: {
      assignedAt: "desc",
    },
    select: {
      id: true,
      assignedAt: true,
      class: {
        select: {
          id: true,
          name: true,
          description: true,
          schedule: true,
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

  return (
    <Panel title="My Classes" subtitle="All classes you are currently enrolled in.">
      {enrollments.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-brand-200 bg-white/70 p-6 text-sm text-slate-600">
          You are not enrolled in any classes yet.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {enrollments.map((enrollment) => (
            <article key={enrollment.id} className="rounded-2xl border border-brand-200 bg-white p-4">
              <h3 className="text-base font-semibold text-slate-900">{enrollment.class.name}</h3>
              <p className="mt-1 text-sm text-slate-600">Teacher: {enrollment.class.teacher.name}</p>
              <p className="text-sm text-slate-600">{enrollment.class.schedule}</p>
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
    </Panel>
  );
}
