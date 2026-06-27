"use client";

import {
  CheckCircle2,
  XCircle,
  TrendingUp,
} from "lucide-react";

export default function TeacherProfileCompletionCard() {
  const items = [
    {
      label: "Profile Photo",
      completed: true,
    },
    {
      label: "Cover Image",
      completed: false,
    },
    {
      label: "About Me",
      completed: true,
    },
    {
      label: "Qualifications",
      completed: true,
    },
    {
      label: "Subjects",
      completed: true,
    },
    {
      label: "Teaching Mediums",
      completed: true,
    },
    {
      label: "Social Links",
      completed: false,
    },
  ];

  const completedCount = items.filter(
    (x) => x.completed
  ).length;

  const percentage = Math.round(
    (completedCount / items.length) * 100
  );

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-slate-900">
            Profile Completion
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            Complete your profile to build trust
            and attract more students.
          </p>
        </div>

        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-100">
          <TrendingUp className="h-6 w-6 text-emerald-600" />
        </div>
      </div>

      {/* Percentage */}
      <div className="mt-6">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-slate-600">
            Completion Progress
          </span>

          <span className="text-lg font-bold text-emerald-600">
            {percentage}%
          </span>
        </div>

        <div className="mt-3 h-3 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-orange-500 transition-all"
            style={{
              width: `${percentage}%`,
            }}
          />
        </div>
      </div>

      {/* Checklist */}
      <div className="mt-6 space-y-3">
        {items.map((item) => (
          <div
            key={item.label}
            className="flex items-center justify-between rounded-xl border border-slate-100 px-3 py-2"
          >
            <span className="text-sm font-medium text-slate-700">
              {item.label}
            </span>

            {item.completed ? (
              <div className="flex items-center gap-2 text-emerald-600">
                <CheckCircle2 className="h-5 w-5" />
              </div>
            ) : (
              <div className="flex items-center gap-2 text-orange-500">
                <XCircle className="h-5 w-5" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="mt-6 rounded-xl border border-orange-100 bg-orange-50 p-4">
        <p className="text-sm text-orange-700">
          Complete your profile to improve your
          visibility in the Teacher Directory and
          make a stronger first impression on
          students.
        </p>
      </div>
    </div>
  );
}