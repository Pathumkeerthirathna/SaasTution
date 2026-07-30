"use client";

import { CheckCircle2, UserCheck } from "lucide-react";

export type StudentRowItem = {
  id: string;
  name: string;
  registrationNumber: string | null;
  grade: {
    id: number | string;
    GradeDesc: string;
  } | null;
  email?: string | null;
  contact01?: string | null;
};

type StudentRowProps = {
  student: StudentRowItem;
  selectable?: boolean;
  selected?: boolean;
  enrolled?: boolean;
  disabled?: boolean;
  onSelect?: (studentId: string, checked: boolean) => void;
  actions?: React.ReactNode;
};

export default function StudentRow({
  student,
  selectable = false,
  selected = false,
  enrolled = false,
  disabled = false,
  onSelect,
  actions,
}: StudentRowProps) {
  return (
    <tr className="border-b border-slate-100 transition-colors hover:bg-slate-50">
      {selectable && (
        <td className="w-12 px-3 py-4 text-center">
          <input
            type="checkbox"
            checked={selected}
            disabled={disabled || enrolled}
            onChange={(e) => onSelect?.(student.id, e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
          />
        </td>
      )}

      {/* Registration */}
      <td className="whitespace-nowrap px-3 py-4">
        <span className="font-mono text-sm font-semibold text-slate-700">
          {student.registrationNumber ?? "-"}
        </span>
      </td>

      {/* Student */}
      <td className="min-w-[220px] px-3 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-slate-800 font-bold text-white">
            {student.name.charAt(0).toUpperCase()}
          </div>

          <div className="min-w-0">
            <p className="truncate font-semibold text-slate-900">
              {student.name}
            </p>

            {student.email && (
              <p className="truncate text-xs text-slate-500">
                {student.email}
              </p>
            )}
          </div>
        </div>
      </td>

      {/* Grade */}
      <td className="whitespace-nowrap px-3 py-4">
        <span className="inline-flex rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
          {student.grade?.GradeDesc ?? "-"}
        </span>
      </td>

      {/* Contact - hidden on phones */}
      <td className="hidden whitespace-nowrap px-3 py-4 md:table-cell">
        <span className="text-sm text-slate-600">
          {student.contact01 ?? "-"}
        </span>
      </td>

      {/* Status */}
      <td className="whitespace-nowrap px-3 py-4">
        {enrolled ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
            <UserCheck size={13} />
            Enrolled
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
            <CheckCircle2 size={13} />
            Available
          </span>
        )}
      </td>

      {/* Actions */}
      {actions && (
        <td className="whitespace-nowrap px-3 py-4 text-right">
          <div className="flex justify-end gap-2">
            {actions}
          </div>
        </td>
      )}
    </tr>
  );
}