interface StudentPapersProps {
  studentId: string;
}

export function StudentPapers({
  studentId,
}: StudentPapersProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="p-4">
        <h2 className="text-lg font-medium text-gray-900">Papers</h2>
        <p className="mt-1 text-sm text-gray-600">
          View the paper records for this student.{" "}
          <span className="font-medium underline">
            {studentId}
          </span>
        </p>
      </div>
    </div>
  );
}