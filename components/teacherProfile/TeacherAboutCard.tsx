"use client";

import {
  Edit,
  Briefcase,
  GraduationCap,
  MapPin,
} from "lucide-react";

interface Props {
  onEdit?: () => void;
}

export default function TeacherAboutCard({
  onEdit,
}: Props) {
  const profile = {
    aboutMe:
      "I am a passionate Mathematics teacher with over 8 years of experience helping students achieve excellent results in Ordinary Level and Advanced Level examinations. My teaching approach focuses on concept mastery, confidence building, and exam-oriented preparation.",

    experience: 8,

    qualification:
      "BSc (Hons) Mathematics, University of Colombo",

    location:
      "Maharagama, Colombo",
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
        <div>
          <h3 className="text-lg font-bold text-slate-900">
            About Me
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            Professional introduction and teaching
            background.
          </p>
        </div>

        <button
          onClick={onEdit}
          className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-100"
        >
          <Edit className="h-4 w-4" />
          Edit
        </button>
      </div>

      {/* Body */}
      <div className="p-6">
        <p className="leading-8 text-slate-600">
          {profile.aboutMe}
        </p>

        {/* Highlights */}
        <div className="mt-6 grid gap-4">
          <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-100">
              <Briefcase className="h-5 w-5 text-orange-600" />
            </div>

            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Experience
              </p>

              <p className="font-semibold text-slate-900">
                {profile.experience} Years
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-100">
              <GraduationCap className="h-5 w-5 text-emerald-600" />
            </div>

            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Highest Qualification
              </p>

              <p className="font-semibold text-slate-900">
                {profile.qualification}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-sky-100">
              <MapPin className="h-5 w-5 text-sky-600" />
            </div>

            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Location
              </p>

              <p className="font-semibold text-slate-900">
                {profile.location}
              </p>
            </div>
          </div>
        </div>

        {/* Quote */}
        <div className="mt-6 rounded-2xl border border-orange-100 bg-gradient-to-r from-orange-50 to-emerald-50 p-5">
          <p className="text-sm italic leading-7 text-slate-700">
            "Education is not about memorizing facts.
            It is about understanding concepts and
            developing the confidence to solve
            problems independently."
          </p>
        </div>
      </div>
    </div>
  );
}