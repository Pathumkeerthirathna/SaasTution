"use client";

import { useEffect, useMemo, useState } from "react";

type LoggedTeacher = {
  id: string;
  name: string;
  email: string;
  classCount: number;
  createdAt: string;
};

type TeacherClass = {
  id: string;
  name: string;
  description: string | null;
  schedule: string;
  studentCount: number;
  createdAt: string;
};

export function AdminTeacherMonitor() {
  const [teachers, setTeachers] = useState<LoggedTeacher[]>([]);
  const [teacherClasses, setTeacherClasses] = useState<TeacherClass[]>([]);
  const [selectedTeacherId, setSelectedTeacherId] = useState<string | null>(null);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loadingTeachers, setLoadingTeachers] = useState(true);
  const [loadingClasses, setLoadingClasses] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function loadTeachers(nextPage = 1) {
    setLoadingTeachers(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/admin/teachers?page=${nextPage}&pageSize=10`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          teachers: LoggedTeacher[];
        };
        pagination?: {
          page: number;
          totalPages: number;
        };
        error?: {
          message?: string;
        };
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.error?.message ?? "Unable to load teachers.");
      }

      setTeachers(payload.data.teachers);
      setPage(payload.pagination?.page ?? nextPage);
      setTotalPages(payload.pagination?.totalPages ?? 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load teachers.";
      setErrorMessage(message);
    } finally {
      setLoadingTeachers(false);
    }
  }

  const selectedTeacher = useMemo(
    () => teachers.find((teacher) => teacher.id === selectedTeacherId) ?? null,
    [teachers, selectedTeacherId]
  );

  const selectedClass = useMemo(
    () => teacherClasses.find((classItem) => classItem.id === selectedClassId) ?? null,
    [teacherClasses, selectedClassId]
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (cancelled) {
        return;
      }

      await loadTeachers(1);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function loadTeacherClasses(teacherId: string) {
    setSelectedTeacherId(teacherId);
    setSelectedClassId(null);
    setTeacherClasses([]);
    setLoadingClasses(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/admin/teachers/${teacherId}/classes`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          classes: TeacherClass[];
        };
        error?: {
          message?: string;
        };
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.error?.message ?? "Unable to load teacher classes.");
      }

      setTeacherClasses(payload.data.classes);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load teacher classes.";
      setErrorMessage(message);
    } finally {
      setLoadingClasses(false);
    }
  }

  return (
    <section className="grid grid-cols-1 gap-5 lg:grid-cols-[1.2fr_1fr]">
      <article className="rounded-3xl border border-brand-200 bg-card p-5 shadow-sm sm:p-6">
        <h2 className="text-lg font-semibold text-slate-900">Registered Teachers</h2>
        <p className="mt-1 text-sm text-slate-600">Select a teacher to view their classes and student registrations.</p>

        {loadingTeachers ? <p className="mt-4 text-sm text-slate-600">Loading teachers...</p> : null}
        {errorMessage ? <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p> : null}
        {!loadingTeachers && !errorMessage && teachers.length === 0 ? (
          <p className="mt-4 text-sm text-slate-600">No registered teachers found.</p>
        ) : null}

        <div className="mt-4 space-y-3">
          {teachers.map((teacher) => {
            const isSelected = teacher.id === selectedTeacherId;

            return (
              <button
                key={teacher.id}
                type="button"
                onClick={() => loadTeacherClasses(teacher.id)}
                className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                  isSelected
                    ? "border-brand-700 bg-brand-50"
                    : "border-brand-200 bg-white hover:border-brand-400 hover:bg-brand-50/60"
                }`}
              >
                <p className="text-sm font-semibold text-slate-900">{teacher.name}</p>
                <p className="text-xs text-slate-600">{teacher.email}</p>
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600">
                  <span>Classes: {teacher.classCount}</span>
                  <span>Registered: {new Date(teacher.createdAt).toLocaleDateString()}</span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            disabled={loadingTeachers || page <= 1}
            onClick={() => void loadTeachers(page - 1)}
            className="rounded-lg border border-brand-300 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
          >
            Previous
          </button>
          <p className="text-xs text-slate-600">
            Page {page} of {totalPages}
          </p>
          <button
            type="button"
            disabled={loadingTeachers || page >= totalPages}
            onClick={() => void loadTeachers(page + 1)}
            className="rounded-lg border border-brand-300 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </article>

      <article className="rounded-3xl border border-brand-200 bg-card p-5 shadow-sm sm:p-6">
        <h2 className="text-lg font-semibold text-slate-900">Class Registrations</h2>
        <p className="mt-1 text-sm text-slate-600">
          {selectedTeacher ? `Classes for ${selectedTeacher.name}` : "Pick a teacher to see class enrollment counts."}
        </p>

        {loadingClasses ? <p className="mt-4 text-sm text-slate-600">Loading classes...</p> : null}
        {!loadingClasses && selectedTeacher && teacherClasses.length === 0 ? (
          <p className="mt-4 text-sm text-slate-600">This teacher has no classes yet.</p>
        ) : null}

        <div className="mt-4 space-y-3">
          {teacherClasses.map((classItem) => {
            const isSelected = classItem.id === selectedClassId;

            return (
              <button
                key={classItem.id}
                type="button"
                onClick={() => setSelectedClassId(classItem.id)}
                className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                  isSelected
                    ? "border-accent bg-accent/10"
                    : "border-brand-200 bg-white hover:border-accent hover:bg-accent/5"
                }`}
              >
                <p className="text-sm font-semibold text-slate-900">{classItem.name}</p>
                <p className="mt-1 text-xs text-slate-600">Schedule: {classItem.schedule}</p>
                <p className="mt-1 text-xs font-medium text-accent">Registered students: {classItem.studentCount}</p>
              </button>
            );
          })}
        </div>

        {selectedClass ? (
          <div className="mt-4 rounded-2xl bg-brand-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-700">Selected Class Details</p>
            <p className="mt-2 text-base font-semibold text-slate-900">{selectedClass.name}</p>
            <p className="mt-1 text-sm text-slate-600">{selectedClass.description || "No description provided."}</p>
            <p className="mt-2 text-sm text-slate-700">Student registrations: {selectedClass.studentCount}</p>
          </div>
        ) : null}
      </article>
    </section>
  );
}
