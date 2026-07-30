"use client";

import StudentRow, { StudentRowItem } from "./StudentRow";

type StudentTableProps = {
  students: StudentRowItem[];

  loading?: boolean;

  selectable?: boolean;

  selectedIds?: Set<string>;

  enrolledIds?: Set<string>;

  onSelect?: (studentId: string, checked: boolean) => void;

  renderActions?: (student: StudentRowItem) => React.ReactNode;

  emptyMessage?: string;
};

export default function StudentTable({
  students,
  loading = false,
  selectable = false,
  selectedIds = new Set(),
  enrolledIds = new Set(),
  onSelect,
  renderActions,
  emptyMessage = "No students found.",
}: StudentTableProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Responsive wrapper */}
      <div className="overflow-x-auto">
        <table className="min-w-[900px] w-full border-collapse">
          <thead className="sticky top-0 bg-slate-50">
            <tr className="border-b border-slate-200">
              {selectable && (
                <th className="w-12 px-4 py-3 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">
                </th>
              )}

              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                Registration No
              </th>

              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                Student
              </th>

              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                Grade
              </th>

              <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 md:table-cell">
                Contact
              </th>

              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                Status
              </th>

              {renderActions && (
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Actions
                </th>
              )}
            </tr>
          </thead>

          <tbody>
            {loading ? (
              [...Array(8)].map((_, index) => (
                <tr key={index} className="border-b border-slate-100">
                  <td
                    colSpan={
                      selectable
                        ? renderActions
                          ? 7
                          : 6
                        : renderActions
                        ? 6
                        : 5
                    }
                    className="px-4 py-4"
                  >
                    <div className="h-10 animate-pulse rounded-lg bg-slate-100" />
                  </td>
                </tr>
              ))
            ) : students.length === 0 ? (
              <tr>
                <td
                  colSpan={
                    selectable
                      ? renderActions
                        ? 7
                        : 6
                      : renderActions
                      ? 6
                      : 5
                  }
                  className="py-14 text-center text-slate-500"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              students.map((student) => (
                <StudentRow
                  key={student.id}
                  student={student}
                  selectable={selectable}
                  selected={selectedIds.has(student.id)}
                  enrolled={enrolledIds.has(student.id)}
                  onSelect={onSelect}
                  actions={renderActions?.(student)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}