"use client";

import {
  Award,
  BookOpen,
  Eye,
  GraduationCap,
  MapPin,
  UserCheck,
} from "lucide-react";

import { ClassTeacher } from "../../../types/teacherProfileTypes/ClassTeacher";

interface Props {
  teacher: ClassTeacher;
}

export default function ClassTeacherCard({
  teacher,
}: Props) {
  return (
    <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">

      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-emerald-50 via-white to-orange-50 px-6 py-4">

        <div>
          <h2 className="text-xl font-bold text-slate-900">
            Meet Your Teacher
          </h2>

          <p className="mt-1 text-sm text-slate-500">
            Learn from an experienced educator.
          </p>
        </div>

        <div className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
          Instructor
        </div>

      </div>

      {/* Body */}

      <div className="p-6">

        <div className="flex flex-col gap-6 lg:flex-row lg:items-center">

          {/* Image */}

          <div className="shrink-0">

            <img
              src={teacher.profileImage}
              alt={teacher.name}
              className="h-36 w-36 rounded-2xl object-cover shadow-md ring-2 ring-slate-100"
            />

          </div>

          {/* Details */}

          <div className="flex-1">

            <div className="flex flex-wrap items-center gap-3">

              <h3 className="text-3xl font-bold text-slate-900">
                {teacher.name}
              </h3>

              <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">

                <UserCheck className="h-3.5 w-3.5" />

                Verified Teacher

              </span>

            </div>

            <p className="mt-2 text-lg font-semibold text-orange-600">
              {teacher.designation}
            </p>

            <div className="mt-5 grid gap-4 md:grid-cols-2">

              <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 p-4">

                <GraduationCap className="h-6 w-6 text-emerald-600" />

                <div>

                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Qualification
                  </p>

                  <p className="font-semibold text-slate-900">
                    {teacher.qualification}
                  </p>

                </div>

              </div>

              <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 p-4">

                <Award className="h-6 w-6 text-orange-500" />

                <div>

                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Experience
                  </p>

                  <p className="font-semibold text-slate-900">
                    {teacher.experience} Years
                  </p>

                </div>

              </div>

              <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 p-4">

                <BookOpen className="h-6 w-6 text-emerald-600" />

                <div>

                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Specialization
                  </p>

                  <p className="font-semibold text-slate-900">
                    Mathematics
                  </p>

                </div>

              </div>

              <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 p-4">

                <MapPin className="h-6 w-6 text-orange-500" />

                <div>

                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Teaching Area
                  </p>

                  <p className="font-semibold text-slate-900">
                    Colombo District
                  </p>

                </div>

              </div>

            </div>

          </div>

          {/* Right */}

          <div className="flex flex-col gap-3">

            <button
              className="
                rounded-xl
                bg-emerald-600
                px-6
                py-3
                text-sm
                font-semibold
                text-white
                transition
                hover:bg-emerald-700
              "
            >
              View Teacher Profile
            </button>

            <button
              className="
                flex
                items-center
                justify-center
                gap-2
                rounded-xl
                border
                border-orange-300
                bg-orange-50
                px-6
                py-3
                text-sm
                font-semibold
                text-orange-700
                transition
                hover:bg-orange-100
              "
            >
              <Eye className="h-4 w-4" />

              See All Classes
            </button>

          </div>

        </div>

      </div>

    </div>
  );
}