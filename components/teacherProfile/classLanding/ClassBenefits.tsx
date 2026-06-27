"use client";

import {
  Award,
  BookOpen,
  CheckCircle2,
  Clock3,
  FileText,
  GraduationCap,
  ShieldCheck,
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
    <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">

      {/* Header */}

      <div className="bg-gradient-to-r from-emerald-600 to-orange-500 px-6 py-5 text-white">

        <h2 className="text-xl font-bold">
          Why Join This Class?
        </h2>

        <p className="mt-2 text-sm text-emerald-50">
          Everything included after you register.
        </p>

      </div>

      {/* Benefits */}

      <div className="p-6">

        <div className="space-y-4">

          {benefits.map((benefit, index) => {

            const Icon =
              icons[index % icons.length];

            return (
              <div
                key={benefit.id}
                className="group flex gap-4 rounded-2xl border border-slate-200 p-4 transition-all duration-300 hover:border-emerald-200 hover:bg-emerald-50/40"
              >

                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 transition group-hover:bg-emerald-600">

                  <Icon className="h-6 w-6 text-emerald-600 group-hover:text-white" />

                </div>

                <div>

                  <h3 className="font-semibold text-slate-900">
                    {benefit.title}
                  </h3>

                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    {benefit.description}
                  </p>

                </div>

              </div>
            );
          })}

        </div>

        {/* Divider */}

        <div className="my-6 border-t border-slate-200" />

        {/* Highlight */}

        <div className="rounded-2xl bg-gradient-to-r from-orange-50 to-emerald-50 p-5">

          <div className="flex items-start gap-3">

            <Award className="mt-0.5 h-7 w-7 text-orange-500" />

            <div>

              <h3 className="font-semibold text-slate-900">
                Premium Learning Experience
              </h3>

              <p className="mt-2 text-sm leading-6 text-slate-600">
                Learn through structured live
                classes, recorded sessions,
                downloadable notes, revision
                papers, quizzes and continuous
                teacher support throughout the
                course.
              </p>

            </div>

          </div>

        </div>

      </div>

    </div>
  );
}