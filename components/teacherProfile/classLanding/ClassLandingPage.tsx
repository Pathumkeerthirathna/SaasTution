"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import ClassHero from "./ClassHero";
import ClassSessionsPreview from "./ClassSessionsPreview";
import ClassNotesPreview from "./ClassNotesPreview";
import ClassBenefits from "./ClassBenefits";
import ClassRegisterCard from "./ClassRegisterCard";
import ClassTrustCard from "./ClassTrustCard";

import { dummyBenefits } from "./dummyData";
import { TeacherClass } from "@/types/teacherProfileTypes/ClassTeacher";
import { ClassLectureSession } from "@/types/teacherProfileTypes/ClassLectureSession";
import { ClassPublicNote } from "@/types/teacherProfileTypes/ClassPublicNote";

interface Props {
  classInfo: TeacherClass;
  sessions?: ClassLectureSession[];
  notes?: ClassPublicNote[];
}

export default function ClassLandingPage({
  classInfo,
  sessions = [],
  notes = [],
}: Props) {

  const router = useRouter();

  return (
    <div className="bg-slate-50">
      {/* Main */}
      <div className="mx-auto max-w-[1500px] px-3 py-4 lg:px-5">

        {/* Back to teacher profile */}
        <div className="mb-4">
          {classInfo.teacherSlug ? (
            <Link
              href={`/${classInfo.teacherSlug}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] font-semibold text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-900"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to teacher profile
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => router.back()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] font-semibold text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-900"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
          )}
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">

          {/* LEFT */}
          <div className="space-y-5">

            <ClassHero classInfo={classInfo} />

            {/* Mobile only */}
            <div className="lg:hidden">
              <ClassRegisterCard
                classId={classInfo.id}
                teacherId={classInfo.teacherId}
              />
            </div>

            <ClassSessionsPreview lectures={sessions} />

            <ClassNotesPreview notes={notes} />

            <ClassBenefits
              benefits={dummyBenefits}
            />

          </div>

          {/* RIGHT */}
          <div className="hidden lg:block">

            <div className="sticky top-4 space-y-5">

              <ClassRegisterCard
                classId={classInfo.id}
                teacherId={classInfo.teacherId}
              />

              <ClassTrustCard />

            </div>

          </div>

        </div>
      </div>
    </div>
  );
}