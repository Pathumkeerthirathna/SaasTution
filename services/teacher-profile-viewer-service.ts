import { getOptionalSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";
import { formatTeacherFullName } from "@/lib/teacher-title";

/*
 * Who is looking at a teacher's profile (app/[slug]/page.tsx), and what a
 * signed-in student may see there.
 *
 * The role comes ONLY from the server-side session (the signed session
 * cookie; student sessions are also checked against the database by
 * getOptionalSession) - never from a query parameter, header or body:
 *   OWNER   - a teacher session whose teacher owns this profile;
 *   STUDENT - a student session with a real relationship to this teacher
 *             (the student's own teacher, or an ACTIVE enrolment in one of
 *             this teacher's active classes);
 *   PUBLIC  - everyone else: no session, another teacher, an admin, or a
 *             student of another teacher. They get the public profile only.
 *
 * Classes: the public profile already lists the teacher's active classes
 * (status 0) - the classes the teacher offers publicly; the project has no
 * private-class flag. A student sees the same list split into ENROLLED (the
 * student's own active ClassStudent rows) and AVAILABLE (the rest). Only the
 * signed-in student's enrolments are read; no other student's enrolment,
 * count or identity is ever loaded.
 */

export type TeacherProfileViewer =
  | { role: "PUBLIC" }
  | { role: "OWNER"; teacherId: string }
  | { role: "STUDENT"; studentId: string };

export type TeacherProfileViewerRole = TeacherProfileViewer["role"];

/** The signed-in student's ACTIVE enrolments in this teacher's active classes (class ids). */
async function activeEnrolledClassIds(studentId: string, teacherId: string): Promise<Set<string>> {
  const rows = await prisma.classStudent.findMany({
    where: { studentId, isActive: true, class: { teacherId, status: 0 } },
    select: { classId: true },
  });
  return new Set(rows.map((row) => row.classId));
}

/** True when the student belongs to this teacher, or is actively enrolled in one of the teacher's active classes. */
export async function studentRelatesToTeacher(studentId: string, teacherId: string): Promise<boolean> {
  const student = await prisma.student.findUnique({ where: { id: studentId }, select: { teacherId: true, status: true } });
  if (!student || student.status !== 0) return false;
  if (student.teacherId === teacherId) return true;
  return (await activeEnrolledClassIds(studentId, teacherId)).size > 0;
}

/** The viewer of `teacherId`'s profile, from the server-side session only. */
export async function resolveTeacherProfileViewer(teacherId: string): Promise<TeacherProfileViewer> {
  const session = await getOptionalSession();
  if (!session) return { role: "PUBLIC" };
  if (session.role === "TEACHER" && session.userId === teacherId) return { role: "OWNER", teacherId };
  if (session.role === "STUDENT" && (await studentRelatesToTeacher(session.userId, teacherId))) {
    return { role: "STUDENT", studentId: session.userId };
  }
  return { role: "PUBLIC" };
}

/**
 * Splits the profile's PUBLIC class list for one student: enrolled (the
 * student's own active enrolments) and available (everything else on the
 * list). Classes not on the public list are never added.
 */
export async function splitClassesForStudent<T extends { id: string }>(
  studentId: string,
  teacherId: string,
  publicClasses: readonly T[]
): Promise<{ enrolled: T[]; available: T[] }> {
  const enrolledIds = await activeEnrolledClassIds(studentId, teacherId);
  return {
    enrolled: publicClasses.filter((item) => enrolledIds.has(item.id)),
    available: publicClasses.filter((item) => !enrolledIds.has(item.id)),
  };
}

export type StudentTeacherLink = {
  teacherId: string;
  name: string;
  designation: string | null;
  profileImageUrl: string | null;
  /** The public profile slug; null when the teacher has no public profile (nothing to open). */
  slug: string | null;
  /** Active classes the student is enrolled in with this teacher. */
  enrolledClassCount: number;
};

/**
 * Every teacher the student relates to - the student's own teacher plus the
 * teacher of any class the student is actively enrolled in - for the
 * "Teacher Profile" page of the student portal. A student may relate to more
 * than one teacher.
 */
export async function listStudentTeachers(studentId: string): Promise<StudentTeacherLink[]> {
  const student = await prisma.student.findUnique({ where: { id: studentId }, select: { teacherId: true, status: true } });
  if (!student || student.status !== 0) return [];

  const enrolments = await prisma.classStudent.findMany({
    where: { studentId, isActive: true, class: { status: 0 } },
    select: { class: { select: { teacherId: true } } },
  });
  const counts = new Map<string, number>([[student.teacherId, 0]]);
  for (const row of enrolments) counts.set(row.class.teacherId, (counts.get(row.class.teacherId) ?? 0) + 1);

  const teachers = await prisma.teacher.findMany({
    where: { id: { in: [...counts.keys()] } },
    select: {
      id: true,
      name: true,
      profile: { select: { slug: true, isPublic: true, title: true, displayName: true, designation: true, profileImageUrl: true } },
    },
  });

  return teachers
    .map((teacher) => {
      const profile = teacher.profile;
      const visible = Boolean(profile && profile.isPublic);
      return {
        teacherId: teacher.id,
        name: visible && profile ? formatTeacherFullName({ name: teacher.name, profile: { title: profile.title, displayName: profile.displayName } }) : teacher.name,
        designation: visible ? (profile?.designation ?? null) : null,
        profileImageUrl: visible ? (profile?.profileImageUrl ?? null) : null,
        slug: visible ? (profile?.slug ?? null) : null,
        enrolledClassCount: counts.get(teacher.id) ?? 0,
      };
    })
    .sort((a, b) => b.enrolledClassCount - a.enrolledClassCount || a.name.localeCompare(b.name));
}
