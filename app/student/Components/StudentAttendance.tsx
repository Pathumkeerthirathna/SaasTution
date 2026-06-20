"use client";

import { BookOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface ClassAttendance {
  classId: string;
  className: string;
  attendedLectures: number;
  totalLectures: number;
  attendancePercentage: number;
}

interface LectureAttendance {
  lectureId: string;
  title: string;
  date: string;
  attended: boolean;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
}

interface StudentAttendanceProps {
  studentId: string;
}

export function StudentAttendance({
  studentId,
}: StudentAttendanceProps) {
  const [classes, setClasses] = useState<ClassAttendance[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [lectures, setLectures] = useState<LectureAttendance[]>([]);

  const loadAttendance = useCallback(async () => {
    try {
      setLoading(true);

      const response = await fetch(
        `/api/student/Profile/${studentId}/attendance`
      );

      const result: ApiResponse<ClassAttendance[]> = await response.json();

      if (result.success && result.data) {
        setClasses(result.data);
      }
    } finally {
      setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    loadAttendance();
  }, [loadAttendance]);

  const toggleAttendanceDetails = useCallback(async (classId: string) => {
    if (selectedClassId === classId) {
      setSelectedClassId(null);
      setLectures([]);
      return;
    }

    setSelectedClassId(classId);

    const response = await fetch(
      `/api/student/Profile/${studentId}/attendance/${classId}`
    );

    const result: ApiResponse<LectureAttendance[]> = await response.json();

    if (result.success && result.data) {
      setLectures(result.data);
    }
  }, [selectedClassId, studentId]);

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