"use client";

import {
  CheckCircle2,
  GraduationCap,
  Target,
  Trophy,
} from "lucide-react";

import { LearningOutcome } from "../../../types/teacherProfileTypes/LearningOutcome";

interface Props {
  outcomes: LearningOutcome[];
}

export default function ClassLearningOutcomes({
  outcomes,
}: Props) {
  return (
    <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">

      {/* Header */}

      <div className="border-b border-slate-100 bg-gradient-to-r from-emerald-50 via-white to-orange-50 px-6 py-5">

        <div className="flex items-center gap-3">

          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100">
            <Target className="h-6 w-6 text-emerald-600" />
          </div>

          <div>
            <h2 className="text-xl font-bold text-slate-900">
              Learning Outcomes
            </h2>

            <p className="mt-1 text-sm text-slate-500">
              Skills and knowledge students will
              gain after completing this course.
            </p>
          </div>

        </div>

      </div>

      {/* Outcomes */}

      <div className="p-6">

        <div className="grid gap-5 md:grid-cols-2">

          {outcomes.map((outcome) => (

            <div
              key={outcome.id}
              className="group rounded-2xl border border-slate-200 bg-white p-5 transition-all duration-300 hover:-translate-y-1 hover:border-emerald-200 hover:shadow-lg"
            >

              <div className="flex gap-4">

                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 transition group-hover:bg-emerald-600">

                  <CheckCircle2 className="h-6 w-6 text-emerald-600 group-hover:text-white" />

                </div>

                <div>

                  <h3 className="text-lg font-bold text-slate-900">
                    {outcome.title}
                  </h3>

                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    {outcome.description}
                  </p>

                </div>

              </div>

            </div>

          ))}

        </div>

        {/* Bottom Highlight */}

        <div className="mt-8 rounded-3xl bg-gradient-to-r from-emerald-600 to-orange-500 p-6 text-white">

          <div className="grid gap-6 md:grid-cols-3">

            <div className="flex items-center gap-3">

              <GraduationCap className="h-10 w-10" />

              <div>

                <h3 className="text-xl font-bold">
                  Exam Ready
                </h3>

                <p className="mt-1 text-sm text-emerald-50">
                  Structured lessons aligned with
                  the latest syllabus.
                </p>

              </div>

            </div>

            <div className="flex items-center gap-3">

              <Target className="h-10 w-10" />

              <div>

                <h3 className="text-xl font-bold">
                  Practical Skills
                </h3>

                <p className="mt-1 text-sm text-emerald-50">
                  Develop confidence through
                  exercises and guided practice.
                </p>

              </div>

            </div>

            <div className="flex items-center gap-3">

              <Trophy className="h-10 w-10" />

              <div>

                <h3 className="text-xl font-bold">
                  Better Results
                </h3>

                <p className="mt-1 text-sm text-emerald-50">
                  Improve performance using
                  revision papers and exam
                  techniques.
                </p>

              </div>

            </div>

          </div>

        </div>

      </div>

    </div>
  );
}