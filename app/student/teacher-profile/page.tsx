import Link from "next/link";
import { BookOpen, ChevronRight, UserRound } from "lucide-react";

import { requireStudentSession } from "@/lib/auth-session";
import { teacherProfilePath } from "@/lib/site-url";
import { listStudentTeachers } from "@/services/teacher-profile-viewer-service";

/*
 * Student portal: "Teacher Profile". Lists every teacher the signed-in
 * student relates to (their own teacher, plus the teacher of any class they
 * are actively enrolled in - possibly more than one) and opens the teacher's
 * existing public profile page, where the server recognises the student
 * session and shows the student's enrolled / available classes.
 * Read-only; the student id comes from the session only.
 */

export const dynamic = "force-dynamic";

export default async function StudentTeacherProfilePage() {
  const session = await requireStudentSession();
  const teachers = await listStudentTeachers(session.studentId);

  return (
    <section className="space-y-4">
      <p className="text-sm text-slate-600">
        {teachers.length > 1
          ? "Choose a teacher to see their profile, your enrolled classes, other available classes and payment details."
          : "See your teacher's profile, your enrolled classes, other available classes and payment details."}
      </p>

      {teachers.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-brand-200 bg-white/70 p-6 text-sm text-slate-600">No teacher is linked to your account.</div>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {teachers.map((teacher) => (
            <li key={teacher.teacherId} className="flex flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-3">
                {teacher.profileImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={teacher.profileImageUrl} alt="" className="h-14 w-14 shrink-0 rounded-full object-cover ring-2 ring-slate-100" />
                ) : (
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                    <UserRound className="h-7 w-7" />
                  </span>
                )}
                <div className="min-w-0">
                  <p className="break-words text-[15px] font-semibold text-slate-900">{teacher.name}</p>
                  {teacher.designation ? <p className="break-words text-[13px] text-amber-700">{teacher.designation}</p> : null}
                  <p className="mt-0.5 flex items-center gap-1 text-[12.5px] text-slate-500">
                    <BookOpen className="h-3.5 w-3.5" />
                    {teacher.enrolledClassCount === 1 ? "1 enrolled class" : `${teacher.enrolledClassCount} enrolled classes`}
                  </p>
                </div>
              </div>
              <div className="mt-4">
                {teacher.slug ? (
                  <Link
                    href={teacherProfilePath(teacher.slug)}
                    className="inline-flex w-full items-center justify-center gap-1 rounded-md bg-[#4D6C90] py-2 text-[13px] font-semibold text-white transition hover:bg-[#3B5776]"
                  >
                    Open teacher profile <ChevronRight className="h-4 w-4" />
                  </Link>
                ) : (
                  <p className="rounded-md bg-slate-50 py-2 text-center text-[13px] text-slate-500">This teacher&apos;s profile is not public yet.</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
