"use client";

import { Edit, Languages } from "lucide-react";

interface Props {
  onEdit?: () => void;
}

export default function TeacherMediumsCard({
  onEdit,
}: Props) {
  const mediums = [
    "Sinhala",
    "English",
    "Tamil",
  ];

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
        <div>
          <h3 className="text-lg font-bold text-slate-900">
            Teaching Mediums
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            Languages available for teaching.
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
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-100">
            <Languages className="h-6 w-6 text-emerald-600" />
          </div>

          <div>
            <p className="text-sm text-slate-500">
              Available Mediums
            </p>

            <p className="font-semibold text-slate-900">
              {mediums.length} Mediums
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          {mediums.map((medium) => (
            <div
              key={medium}
              className="rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700"
            >
              {medium}
            </div>
          ))}
        </div>

        {/* Info Box */}
        <div className="mt-6 rounded-xl border border-orange-100 bg-orange-50 p-4">
          <p className="text-sm leading-6 text-orange-700">
            Students can easily identify the
            languages you teach in when viewing
            your public profile.
          </p>
        </div>
      </div>
    </div>
  );
}