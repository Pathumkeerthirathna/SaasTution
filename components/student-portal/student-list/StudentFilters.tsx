"use client";

import { Search, RotateCcw } from "lucide-react";

export type StudentFiltersValue = {
  name: string;
  registrationNumber: string;
  gradeId: string;
};

type GradeOption = {
  id: string;
  name: string;
};

type StudentFiltersProps = {
  value: StudentFiltersValue;
  grades: GradeOption[];

  onChange: (value: StudentFiltersValue) => void;
  onSearch?: () => void;
  onReset?: () => void;

  loading?: boolean;
};

export default function StudentFilters({
  value,
  grades,
  onChange,
  onSearch,
  onReset,
  loading = false,
}: StudentFiltersProps) {
  const update = (
    field: keyof StudentFiltersValue,
    fieldValue: string
  ) => {
    onChange({
      ...value,
      [field]: fieldValue,
    });
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">

        {/* Student Name */}
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700">
            Student Name
          </label>

          <input
            type="text"
            placeholder="Search name..."
            value={value.name}
            onChange={(e) => update("name", e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>

        {/* Registration Number */}
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700">
            Registration No
          </label>

          <input
            type="text"
            placeholder="Registration No"
            value={value.registrationNumber}
            onChange={(e) =>
              update("registrationNumber", e.target.value)
            }
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>

        {/* Grade */}
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700">
            Grade
          </label>

          <select
            value={value.gradeId}
            onChange={(e) => update("gradeId", e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          >
            <option value="">All Grades</option>

            {grades.map((grade) => (
              <option key={grade.id} value={grade.id}>
                {grade.name}
              </option>
            ))}
          </select>
        </div>

        {/* Buttons */}
        <div className="flex items-end gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={onSearch}
            className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="flex items-center justify-center gap-2">
              <Search size={16} />
              Search
            </span>
          </button>

          <button
            type="button"
            disabled={loading}
            onClick={onReset}
            className="rounded-lg border border-slate-300 bg-white p-2.5 text-slate-600 transition hover:bg-slate-100"
            title="Reset Filters"
          >
            <RotateCcw size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}