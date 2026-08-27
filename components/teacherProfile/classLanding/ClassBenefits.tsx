"use client";

import {
  Award,
  BookOpen,
  CheckCircle2,
  Clock3,
  FileText,
  GraduationCap,
  ShieldCheck,
  Sparkles,
  Video,
} from "lucide-react";

import { ClassBenefit } from "../../../types/teacherProfileTypes/ClassBenefit";

interface Props {
  benefits: ClassBenefit[];
}

const icons = [
  GraduationCap,
  Video,
  FileText,
  Award,
  BookOpen,
  Clock3,
  ShieldCheck,
  CheckCircle2,
];

export default function ClassBenefits({
  benefits,
}: Props) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">

      {/* Header */}
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-3.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100">
          <Sparkles className="h-4 w-4 text-emerald-600" />
        </div>

        <div>
          <h2 className="text-[16px] font-bold text-slate-900">
            Why Join This Class?
          </h2>
          <p className="mt-0.5 text-[14px] text-slate-500">
            Everything included after you register.
          </p>
        </div>
      </div>

      {/* Benefits */}
      <div className="p-5">

        <div className="space-y-2.5">

          {benefits.map((benefit, index) => {
            const Icon = icons[index % icons.length];

            return (
              <div
                key={benefit.id}
                className="group flex gap-3 rounded-lg border border-slate-200 p-3 transition hover:border-emerald-200 hover:bg-emerald-50/40"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 transition group-hover:bg-emerald-600">
                  <Icon className="h-4 w-4 text-emerald-600 group-hover:text-white" />
                </div>

                <div>
                  <h3 className="text-[14px] font-semibold text-slate-900">
                    {benefit.title}
                  </h3>
                  <p className="mt-0.5 text-[13px] leading-5 text-slate-600">
                    {benefit.description}
                  </p>
                </div>
              </div>
            );
          })}

        </div>

        {/* Highlight */}
        <div className="mt-4 rounded-xl border border-orange-100 bg-gradient-to-r from-orange-50 to-emerald-50 p-3">
          <div className="flex items-start gap-2.5">
            <Award className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
            <div>
              <h3 className="text-[14px] font-semibold text-slate-900">
                Premium Learning Experience
              </h3>
              <p className="mt-0.5 text-[13px] leading-5 text-slate-600">
                Structured live classes, recorded sessions, downloadable notes, revision papers, quizzes and continuous teacher support throughout the course.
              </p>
            </div>
          </div>
        </div>

      </div>

    </div>
  );
}
