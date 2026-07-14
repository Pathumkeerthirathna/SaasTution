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
import { useEffect, useState } from "react";
import { ClassItem } from "@/components/class-management-panel";
import { TeacherClass } from "@/types/teacherProfileTypes/ClassTeacher";

interface Props {
  classInfo: TeacherClass;
}

export default function ClassLandingPage({
  classInfo,
}: Props) {

  // const [classInfo, setClassInfo] =
  //   useState<ClassItem | null>(null);

  // const [loading, setLoading] =
  //   useState(true);

  // useEffect(() => {

  //   async function loadClass() {
  //     try {
  //       setLoading(true);


  //       console.log(classId);

  //       const response = await fetch(`/api/classes/${classId}`);
  //       const payload = await response.json();

  //       console.log(payload);

  //       if (payload.success) {
  //         setClassInfo(payload.data);
  //       }
  //     } catch (error) {
  //       console.error(error);
  //     } finally {
  //       setLoading(false);
  //     }
  //   }

  //   loadClass(); 

  // }, [classId]);

  

  // if (loading) {
  //   return (
  //     <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 shadow-sm animate-pulse">
  //       <div className="flex flex-col gap-6 lg:flex-row lg:justify-between">

  //         {/* Left */}
  //         <div className="flex gap-5">

  //           {/* Avatar */}
  //           <div className="h-28 w-28 rounded-full bg-slate-200" />

  //           {/* Details */}
  //           <div className="space-y-4">
  //             <div className="h-8 w-64 rounded bg-slate-200" />
  //             <div className="h-5 w-48 rounded bg-slate-200" />
  //             <div className="h-4 w-72 rounded bg-slate-200" />
  //             <div className="h-4 w-56 rounded bg-slate-200" />

  //             <div className="flex gap-4">
  //               <div className="h-4 w-32 rounded bg-slate-200" />
  //               <div className="h-4 w-32 rounded bg-slate-200" />
  //             </div>
  //           </div>
  //         </div>

  //         {/* Right */}
  //         <div className="space-y-4">
  //           <div className="h-11 w-40 rounded-xl bg-slate-200" />
  //           <div className="h-4 w-24 rounded bg-slate-200" />

  //           <div className="flex gap-2">
  //             <div className="h-8 w-20 rounded-full bg-slate-200" />
  //             <div className="h-8 w-20 rounded-full bg-slate-200" />
  //             <div className="h-8 w-20 rounded-full bg-slate-200" />
  //           </div>
  //         </div>

  //       </div>
  //     </div>
  //   );
  // }

  // if (!classInfo) {
  //   return (
  //     <div className="p-10 text-center">
  //       Class not found.
  //     </div>
  //   );
  // }

   

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

          {/* LEFT SIDE */}
          <div className="space-y-6">

            <ClassHero
              classInfo={classInfo}
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
                classId={classInfo.id}
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