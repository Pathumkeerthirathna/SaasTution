"use client";

import {
  Award,
  Pencil,
  Plus,
  Trash2,
  Trophy,
} from "lucide-react";

interface Props {
  onAdd?: () => void;
}

export default function TeacherAchievementCard({
  onAdd,
}: Props) {
  const achievements = [
    {
      id: 1,
      title: "Best Mathematics Teacher Award",
      description:
        "Recognized for outstanding student performance and innovative teaching methods.",
      year: 2025,
    },
    {
      id: 2,
      title: "100% A Pass Achievement",
      description:
        "Achieved 100% A pass rate for O/L Mathematics students.",
      year: 2024,
    },
    {
      id: 3,
      title: "Educational Excellence Recognition",
      description:
        "Awarded by ABC Educational Institute for contributions to student success.",
      year: 2023,
    },
  ];

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
        <div>
          <h3 className="text-lg font-bold text-slate-900">
            Achievements & Awards
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            Showcase your accomplishments and
            professional recognition.
          </p>
        </div>

        <button
          onClick={onAdd}
          className="flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-orange-600"
        >
          <Plus className="h-4 w-4" />
          Add Achievement
        </button>
      </div>

      {/* Body */}
      <div className="p-6">
        <div className="space-y-5">
          {achievements.map((achievement) => (
            <div
              key={achievement.id}
              className="group rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-orange-200 hover:shadow-md"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                {/* Left */}
                <div className="flex gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-orange-100">
                    <Trophy className="h-6 w-6 text-orange-600" />
                  </div>

                  <div>
                    <div className="flex flex-wrap items-center gap-3">
                      <h4 className="text-lg font-semibold text-slate-900">
                        {achievement.title}
                      </h4>

                      <span className="rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-700">
                        {achievement.year}
                      </span>
                    </div>

                    <p className="mt-2 text-sm leading-7 text-slate-600">
                      {achievement.description}
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                  <button
                    title="Edit Achievement"
                    className="rounded-xl border border-slate-200 p-2 text-slate-600 transition hover:bg-slate-50"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>

                  <button
                    title="Delete Achievement"
                    className="rounded-xl border border-red-200 p-2 text-red-500 transition hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Summary Card */}
        <div className="mt-6 rounded-2xl border border-orange-100 bg-gradient-to-r from-orange-50 to-amber-50 p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-orange-100">
              <Award className="h-6 w-6 text-orange-600" />
            </div>

            <div>
              <p className="text-sm text-slate-500">
                Total Achievements
              </p>

              <h4 className="text-xl font-bold text-slate-900">
                {achievements.length}
              </h4>
            </div>
          </div>

          <p className="mt-4 text-sm leading-6 text-slate-700">
            Highlighting awards and accomplishments
            helps build trust and credibility among
            students and parents viewing your
            profile.
          </p>
        </div>
      </div>
    </div>
  );
}