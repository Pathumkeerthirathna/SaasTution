"use client";

import { BookOpen, CalendarCheck } from "lucide-react";
import { useEffect, useState } from "react";

interface StudentAttendanceProps {
  studentId: string;
}

export function StudentAttendance({
  studentId,
}: StudentAttendanceProps) {
  const [classes, setClasses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [lectures, setLectures] = useState<any[]>([]);

  useEffect(() => {
    loadAttendance();
  }, [studentId]);

  async function loadAttendance() {
    try {
      setLoading(true);

      const response = await fetch(
        `/api/student/Profile/${studentId}/attendance`
      );

      const result = await response.json();

      if (result.success) {
        setClasses(result.data);
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadAttendanceDetails(classId: string) {
    setSelectedClassId(classId);

    const response = await fetch(
      `/api/student/Profile/${studentId}/attendance/${classId}`
    );

    const result = await response.json();

    if (result.success) {
      setLectures(result.data);
    }
  }

  async function toggleAttendanceDetails(classId: string) {

    if (selectedClassId === classId) {
      setSelectedClassId(null);
      setLectures([]);
      return;
    }

    setSelectedClassId(classId);

    const response = await fetch(
      `/api/student/Profile/${studentId}/attendance/${classId}`
    );

    const result = await response.json();

    if (result.success) {
      setLectures(result.data);
    }
  }

  if (loading) {
    return <div>Loading attendance...</div>;
  }

  return (
    <div className="space-y-4">
      {classes.map((item) => (
        <div
          key={item.classId}
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-semibold">
                <BookOpen className="h-5 w-5 text-blue-600" />
                {item.className}
              </h3>

              <p className="mt-1 text-sm text-slate-500">
                {item.attendedLectures} of {item.totalLectures}
                {" "}lectures attended
              </p>
            </div>

            <div className="text-right">
              <div
                className={`text-xl font-bold ${
                  item.attendancePercentage >= 75
                    ? "text-emerald-600"
                    : "text-red-600"
                }`}
              >
                {item.attendancePercentage}%
              </div>

              <div className="text-xs text-slate-500">
                Attendance
              </div>
            </div>
          </div>

          <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full ${
                item.attendancePercentage >= 75
                  ? "bg-emerald-500"
                  : "bg-red-500"
              }`}
              style={{
                width: `${item.attendancePercentage}%`,
              }}
            />
          </div>

          <button
            onClick={() => toggleAttendanceDetails(item.classId)}
            className={`mt-4 rounded-lg px-4 py-2 text-sm font-medium transition
              ${
                selectedClassId === item.classId
                  ? "bg-slate-200 text-slate-700 hover:bg-slate-300"
                  : "bg-blue-600 text-white hover:bg-blue-700"
              }`}
          >
            {selectedClassId === item.classId
              ? "Hide Details"
              : "View Details"}
          </button>

          {selectedClassId === item.classId && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <h4 className="mb-3 font-semibold">
                Lecture Attendance
              </h4>

              {lectures.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No lecture records found.
                </p>
              ) : (
                lectures.map((lecture) => (
                  <div
                    key={lecture.lectureId}
                    className="flex items-center justify-between border-b py-2 last:border-0"
                  >
                    <div>
                      <div className="font-medium">
                        {lecture.title}
                      </div>

                      <div className="text-xs text-slate-500">
                        {new Date(
                          lecture.date
                        ).toLocaleDateString()}
                      </div>
                    </div>

                    <span
                      className={`rounded-full px-3 py-1 text-xs font-medium ${
                        lecture.attended
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {lecture.attended
                        ? "Present"
                        : "Absent"}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}

        </div>
      ))}
    </div>
  );
}