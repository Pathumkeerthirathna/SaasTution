"use client";

import ClassHero from "./ClassHero";
import ClassSessionsPreview from "./ClassSessionsPreview";
import ClassNotesPreview from "./ClassNotesPreview";
import ClassLearningOutcomes from "./ClassLearningOutcomes";
import ClassBenefits from "./ClassBenefits";
import ClassTestimonials from "./ClassTestimonials";
import ClassRegisterCard from "./ClassRegisterCard";
import ClassTrustCard from "./ClassTrustCard";

import {dummySessions,dummyNotes,dummyLearningOutcomes,dummyTestimonials,dummyBenefits } from "./dummyData";
import { TeacherClass } from "@/types/teacherProfileTypes/ClassTeacher";

interface Props {
  classInfo: TeacherClass;
}

export default function ClassLandingPage({
  classInfo,
}: Props) {



  return (
    <div className="min-h-screen bg-slate-50">
      {/* Breadcrumb */}
      {/* <div className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-4 text-sm text-slate-500 lg:px-8">
          <span>Home</span>

          <span>/</span>

          <span>Classes</span>

          <span>/</span>

          <span className="font-semibold text-slate-800">
            {classInfo.name}
          </span>
        </div>
      </div> */}

      {/* Main */}
      <div className="mx-auto max-w-[1500px] px-3 py-4 lg:px-5">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">

  {/* LEFT */}
  <div className="space-y-6">

    <ClassHero classInfo={classInfo} />

    {/* Mobile only */}
    <div className="lg:hidden">
      <ClassRegisterCard
        classId={classInfo.id}
      />
    </div>

    <ClassSessionsPreview sessions={dummySessions} />

    <ClassNotesPreview notes={dummyNotes} />

    <ClassLearningOutcomes
      outcomes={dummyLearningOutcomes}
    />

    <ClassTestimonials
      testimonials={dummyTestimonials}
    />

  </div>

  {/* RIGHT */}
  <div className="hidden lg:block">

    <div className="sticky top-6 space-y-6">

      <ClassRegisterCard
        classId={classInfo.id}
      />

      <ClassBenefits
        benefits={dummyBenefits}
      />

      <ClassTrustCard />

    </div>

  </div>

</div>
      </div>
    </div>
  );
}