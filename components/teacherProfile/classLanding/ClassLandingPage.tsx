"use client";

import ClassHero from "./ClassHero";
import ClassTeacherCard from "./ClassTeacherCard";
import ClassSessionsPreview from "./ClassSessionsPreview";
import ClassNotesPreview from "./ClassNotesPreview";
import ClassLearningOutcomes from "./ClassLearningOutcomes";
import ClassBenefits from "./ClassBenefits";
import ClassTestimonials from "./ClassTestimonials";
import ClassRegisterCard from "./ClassRegisterCard";
import ClassTrustCard from "./ClassTrustCard";

import { dummyTeacher,dummyPublicClass,dummySessions,dummyNotes,dummyLearningOutcomes,dummyTestimonials,dummyRegisterInfo,dummyBenefits } from "./dummyData";

export default function ClassLandingPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      {/* Breadcrumb */}
      <div className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-4 text-sm text-slate-500 lg:px-8">
          <span>Home</span>

          <span>/</span>

          <span>Classes</span>

          <span>/</span>

          <span className="font-semibold text-slate-800">
            {dummyPublicClass.className}
          </span>
        </div>
      </div>

      {/* Main */}
      <div className="mx-auto max-w-[1500px] px-3 py-4 lg:px-5">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">

          {/* LEFT SIDE */}
          <div className="space-y-6">

            <ClassHero
              classInfo={dummyPublicClass}
            />

            {/* <ClassTeacherCard
              teacher={dummyTeacher}
            /> */}

            <ClassSessionsPreview
              sessions={dummySessions}
            />

            <ClassNotesPreview
              notes={dummyNotes}
            />

            <ClassLearningOutcomes
              outcomes={dummyLearningOutcomes}
            />

            <ClassTestimonials
              testimonials={
                dummyTestimonials
              }
            />

          </div>

          {/* RIGHT SIDE */}
          <div className="space-y-6">

            <div className="sticky top-6 space-y-6">

              <ClassRegisterCard
                classInfo={dummyRegisterInfo}
              />

              <ClassBenefits
                benefits={
                  dummyBenefits
                }
              />

              <ClassTrustCard />

            </div>

          </div>

        </div>
      </div>
    </div>
  );
}