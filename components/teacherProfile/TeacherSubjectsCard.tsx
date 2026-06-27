"use client";

import {
  BookOpen,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

interface Props {
  onEdit?: () => void;
}

export default function TeacherSubjectsCard({
  onEdit,
}: Props) {
  const subjects = [
    {
      id: 1,
      subject: "Mathematics",
      gradeFrom: 6,
      gradeTo: 11,
      mediums: ["Sinhala", "English"],
    },
    {
      id: 2,
      subject: "Combined Mathematics",
      gradeFrom: 12,
      gradeTo: 13,
      mediums: ["English"],
    },
    {
      id: 3,
      subject: "Physics",
      gradeFrom: 12,
      gradeTo: 13,
      mediums: ["Sinhala"],
    },
  ];

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
        <div>
          <h3 className="text-lg font-bold text-slate-900">
            Subjects & Grade Levels
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            Subjects currently taught by this
            teacher.
          </p>
        </div>

        <button
          onClick={onEdit}
          className="flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700"
        >
          <Plus className="h-4 w-4" />
          Manage Subjects
        </button>
      </div>

      {/* Body */}
      <div className="p-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {subjects.map((subject) => (
            <div
              key={subject.id}
              className="group rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-emerald-200 hover:shadow-md"
            >
              <div className="flex items-start justify-between">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-100">
                  <BookOpen className="h-6 w-6 text-emerald-600" />
                </div>

                <div className="flex items-center gap-2">
                  <button
                    className="rounded-lg border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50"
                    title="Edit Subject"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>

                  <button
                    className="rounded-lg border border-red-200 p-2 text-red-500 transition hover:bg-red-50"
                    title="Delete Subject"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <h4 className="mt-4 text-lg font-bold text-slate-900">
                {subject.subject}
              </h4>

              <div className="mt-3 inline-flex rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-700">
                Grade {subject.gradeFrom} -{" "}
                Grade {subject.gradeTo}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {subject.mediums.map((medium) => (
                  <span
                    key={medium}
                    className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700"
                  >
                    {medium}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Summary */}
        <div className="mt-6 rounded-2xl border border-emerald-100 bg-gradient-to-r from-emerald-50 to-orange-50 p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-100">
              <BookOpen className="h-6 w-6 text-emerald-600" />
            </div>

            <div>
              <p className="text-sm text-slate-500">
                Total Subjects
              </p>

              <h4 className="text-xl font-bold text-slate-900">
                {subjects.length}
              </h4>
            </div>
          </div>

          <p className="mt-4 text-sm leading-6 text-slate-700">
            Subjects and grade levels displayed
            here will be visible to students and
            parents on your public profile.
          </p>
        </div>
      </div>
    </div>
  );
}