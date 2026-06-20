interface StudentHistoryProps {
  studentId: string;
}

export function StudentHistory({
  studentId,
}: StudentHistoryProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="p-4">
        <h2 className="text-lg font-medium text-gray-900">History</h2>
        <p className="mt-1 text-sm text-gray-600">
          View the history records for this student.{" "}
          <span className="font-medium underline">
            {studentId}
          </span>
        </p>
      </div>
    </div>
  );
}