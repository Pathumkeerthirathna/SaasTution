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

import {dummySessions,dummyNotes,dummyLearningOutcomes,dummyTestimonials,dummyRegisterInfo,dummyBenefits } from "./dummyData";
import { useEffect, useState } from "react";
import { PublicClass } from "@/types/teacherProfileTypes/PublicClass";
import { ClassItem } from "@/components/class-management-panel";
import { Grade } from "@/types/grade";

interface Props {
  classId: string;
}

export default function ClassLandingPage({
  classId,
}: Props) {

  const [classInfo, setClassInfo] =
    useState<ClassItem | null>(null);

  const [loading, setLoading] =
    useState(true);

  const [grades, setGrades] = useState<Grade[]>([]);
  const [selectedGrade, setSelectedGrade] = useState("");

  useEffect(() => {
    void loadClass();
    void loadGrades();
  }, [classId]);

  async function loadGrades() {
    try {
      const response = await fetch("/api/master/grades");

      if (!response.ok) {
        throw new Error("Failed to load grades");
      }

      const data: Grade[] = await response.json();
      setGrades(data);
    } catch (error) {
      console.error(error);
    }
  }


  async function loadClass() {
    try {
      setLoading(true);


      console.log(classId);

      const response = await fetch(`/api/classes/${classId}`);
      const payload = await response.json();

      console.log(payload);

      if (payload.success) {
        setClassInfo(payload.data);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="p-10 text-center">
        Loading...
      </div>
    );
  }

  if (!classInfo) {
    return (
      <div className="p-10 text-center">
        Class not found.
      </div>
    );
  }

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
                classId={classId}
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