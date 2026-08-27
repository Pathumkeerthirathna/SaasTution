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
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">

      {/* Header */}
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-3.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100">
          <Target className="h-4 w-4 text-emerald-600" />
        </div>

        <div>
          <h2 className="text-[16px] font-bold text-slate-900">
            Learning Outcomes
          </h2>
          <p className="mt-0.5 text-[14px] text-slate-500">
            Skills and knowledge students gain after completing this course.
          </p>
        </div>
      </div>

      {/* Outcomes */}
      <div className="p-5">

        <div className="grid gap-3 md:grid-cols-2">

          {outcomes.map((outcome) => (
            <div
              key={outcome.id}
              className="group flex gap-3 rounded-lg border border-slate-200 bg-white p-3.5 transition hover:border-emerald-200 hover:shadow-sm"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 transition group-hover:bg-emerald-600">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 group-hover:text-white" />
              </div>

              <div>
                <h3 className="text-[15px] font-semibold text-slate-900">
                  {outcome.title}
                </h3>
                <p className="mt-0.5 text-[14px] leading-5 text-slate-600">
                  {outcome.description}
                </p>
              </div>
            </div>
          ))}

        </div>

        {/* Bottom highlight */}
        <div className="mt-4 rounded-xl bg-gradient-to-r from-emerald-600 to-orange-500 p-4 text-white">
          <div className="grid gap-4 md:grid-cols-3">

            {[
              { icon: GraduationCap, title: "Exam Ready", text: "Structured lessons aligned with the latest syllabus." },
              { icon: Target, title: "Practical Skills", text: "Build confidence through exercises and guided practice." },
              { icon: Trophy, title: "Better Results", text: "Improve performance with revision papers and exam techniques." },
            ].map(({ icon: Icon, title, text }) => (
              <div key={title} className="flex items-start gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/15">
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-[14px] font-bold">
                    {title}
                  </h3>
                  <p className="mt-0.5 text-[13px] leading-5 text-emerald-50">
                    {text}
                  </p>
                </div>
              </div>
            ))}

          </div>
        </div>

      </div>

    </div>
  );
}
