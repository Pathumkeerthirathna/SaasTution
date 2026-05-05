"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type StudentListItem = {
  id: string;
  name: string;
  grade: string | null;
  contact01: string | null;
  contact02: string | null;
  email: string | null;
  registrationNumber: string | null;
  classes: {
    id: string;
    name: string;
  }[];
  createdAt: string;
};

type ApiError = {
  message?: string;
};

type PaginatedStudentsResponse = {
  success: boolean;
  data?: StudentListItem[];
  error?: ApiError;
  pagination?: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
};

const PAGE_SIZE = 6;
const GRADE_OPTIONS = [
  "GRADE_01",
  "GRADE_02",
  "GRADE_03",
  "GRADE_04",
  "GRADE_05",
  "GRADE_06",
  "GRADE_07",
  "GRADE_08",
  "GRADE_09",
  "GRADE_10",
  "GRADE_11",
  "GRADE_12",
  "GRADE_13",
] as const;

function formatGradeLabel(value: string | null) {
  if (!value) {
    return "-";
  }

  return value.startsWith("GRADE_") ? `Grade ${value.slice(6)}` : value;
}

export function StudentGuardianManagementPanel() {
  const [students, setStudents] = useState<StudentListItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [filters, setFilters] = useState({
    name: "",
    grade: "" as "" | (typeof GRADE_OPTIONS)[number],
  });

  const [isLoadingList, setIsLoadingList] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [isAddPanelOpen, setIsAddPanelOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [studentForm, setStudentForm] = useState({
    name: "",
    grade: "" as "" | (typeof GRADE_OPTIONS)[number],
    contact01: "",
    contact02: "",
    email: "",
  });

  const hasStudents = useMemo(() => students.length > 0, [students]);

  const loadStudentList = useCallback(async (nextPage = 1, appliedFilters = filters) => {
    setIsLoadingList(true);
    setErrorMessage(null);

    try {
      const query = new URLSearchParams({
        page: String(nextPage),
        pageSize: String(PAGE_SIZE),
      });

      if (appliedFilters.name.trim()) {
        query.set("name", appliedFilters.name.trim());
      }

      if (appliedFilters.grade) {
        query.set("grade", appliedFilters.grade);
      }

      const response = await fetch(`/api/students?${query.toString()}`);
      const payload = (await response.json()) as PaginatedStudentsResponse;

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to load students.");
        return;
      }

      setStudents(payload.data ?? []);
      setPage(payload.pagination?.page ?? nextPage);
      setTotalPages(payload.pagination?.totalPages ?? 1);
    } catch {
      setErrorMessage("Unable to load students right now.");
    } finally {
      setIsLoadingList(false);
    }
  }, [filters]);

  useEffect(() => {
    void loadStudentList(1, { name: "", grade: "" });
  }, [loadStudentList]);

  async function handleCreateStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch("/api/students", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(studentForm),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: ApiError;
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to add student.");
        return;
      }

      setStudentForm({
        name: "",
        grade: "",
        contact01: "",
        contact02: "",
        email: "",
      });
      setSuccessMessage("Student added successfully.");
      await loadStudentList(1, filters);
      setIsAddPanelOpen(false);
    } catch {
      setErrorMessage("Unable to add student right now.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="relative">
      <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Student list</h2>
            <p className="mt-1 text-sm text-muted">Page {page} of {totalPages}</p>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setIsAddPanelOpen(true)}
              className="rounded-xl bg-foreground px-4 py-2 text-sm font-semibold text-background"
            >
              Add student
            </button>
            <button
              type="button"
              onClick={() => setIsHelpOpen(true)}
              className="rounded-xl border border-black/15 px-4 py-2 text-sm font-semibold dark:border-white/20"
            >
              Help
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            value={filters.name}
            onChange={(event) => setFilters((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="Filter by student name"
            className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
          />

          <select
            value={filters.grade}
            onChange={(event) =>
              setFilters((prev) => ({
                ...prev,
                grade: event.target.value as "" | (typeof GRADE_OPTIONS)[number],
              }))
            }
            className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
          >
            <option value="">Filter by grade</option>
            {GRADE_OPTIONS.map((grade) => (
              <option key={grade} value={grade}>
                {formatGradeLabel(grade)}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={isLoadingList}
            onClick={() => void loadStudentList(1, filters)}
            className="btn-primary"
          >
            Apply filters
          </button>
          <button
            type="button"
            disabled={isLoadingList}
            onClick={() => {
              const cleared = { name: "", grade: "" as "" | (typeof GRADE_OPTIONS)[number] };
              setFilters(cleared);
              void loadStudentList(1, cleared);
            }}
            className="btn-ghost"
          >
            Clear
          </button>
        </div>

        {errorMessage ? (
          <p className="notice-error mt-4">{errorMessage}</p>
        ) : null}

        {successMessage ? (
          <p className="notice-success mt-4">
            {successMessage}
          </p>
        ) : null}

        {isLoadingList ? <p className="mt-5 text-sm text-muted">Loading students...</p> : null}

        {!isLoadingList && !hasStudents ? (
          <p className="mt-5 text-sm text-muted">No students found. Add students or adjust your filters.</p>
        ) : null}

        <div className="table-wrap mt-5">
          <table className="table-modern">
            <thead>
              <tr>
                <th className="px-4 py-3">Reg no</th>
                <th className="px-4 py-3">Student</th>
                <th className="px-4 py-3">Grade</th>
                <th className="px-4 py-3">Contact 01</th>
                <th className="px-4 py-3">Contact 02</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Classes</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {students.map((student) => (
                <tr key={student.id} className="bg-transparent">
                  <td className="px-4 py-3 font-semibold text-foreground">{student.registrationNumber ?? "-"}</td>
                  <td className="px-4 py-3 font-medium">{student.name}</td>
                  <td className="px-4 py-3 text-muted">{formatGradeLabel(student.grade)}</td>
                  <td className="px-4 py-3 text-muted">{student.contact01 || "-"}</td>
                  <td className="px-4 py-3 text-muted">{student.contact02 || "-"}</td>
                  <td className="px-4 py-3 text-muted">{student.email || "-"}</td>
                  <td className="px-4 py-3 text-muted">
                    {student.classes.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {student.classes.map((classItem) => (
                          <span
                            key={classItem.id}
                            className="rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700"
                          >
                            {classItem.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/students/${student.id}`}
                      className="btn-ghost px-3 py-1.5 text-xs"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={isLoadingList || page <= 1}
            onClick={() => void loadStudentList(page - 1, filters)}
            className="btn-ghost"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={isLoadingList || page >= totalPages}
            onClick={() => void loadStudentList(page + 1, filters)}
            className="btn-primary"
          >
            Next
          </button>
        </div>
      </article>

      <button
        type="button"
        aria-label="Close add student panel"
        onClick={() => setIsAddPanelOpen(false)}
        className={`fixed inset-0 z-40 bg-black/40 transition ${isAddPanelOpen ? "visible opacity-100" : "invisible opacity-0"}`}
      />

      <aside
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-xl overflow-y-auto border-l border-black/10 bg-card p-5 shadow-2xl transition-transform duration-300 dark:border-white/10 sm:p-6 ${
          isAddPanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Add student</h3>
            <p className="mt-1 text-sm text-muted">Create student with grade, contacts, and email.</p>
          </div>
          <button
            type="button"
            onClick={() => setIsAddPanelOpen(false)}
            className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold dark:border-white/20"
          >
            Close
          </button>
        </div>

        <form className="mt-4 space-y-4" onSubmit={handleCreateStudent}>
          <input
            required
            value={studentForm.name}
            onChange={(event) => setStudentForm((prev) => ({ ...prev, name: event.target.value }))}
            className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
            placeholder="Student name"
          />
          <select
            value={studentForm.grade}
            onChange={(event) =>
              setStudentForm((prev) => ({
                ...prev,
                grade: event.target.value as "" | (typeof GRADE_OPTIONS)[number],
              }))
            }
            className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
          >
            <option value="">Select grade (optional)</option>
            {GRADE_OPTIONS.map((grade) => (
              <option key={grade} value={grade}>
                {formatGradeLabel(grade)}
              </option>
            ))}
          </select>
          <input
            required
            value={studentForm.contact01}
            onChange={(event) => setStudentForm((prev) => ({ ...prev, contact01: event.target.value }))}
            className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
            placeholder="Contact 01"
          />
          <input
            required
            value={studentForm.contact02}
            onChange={(event) => setStudentForm((prev) => ({ ...prev, contact02: event.target.value }))}
            className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
            placeholder="Contact 02"
          />
          <input
            type="email"
            required
            value={studentForm.email}
            onChange={(event) => setStudentForm((prev) => ({ ...prev, email: event.target.value }))}
            className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
            placeholder="Email"
          />
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-xl bg-foreground px-4 py-2.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? "Saving..." : "Add student"}
          </button>
        </form>
      </aside>

      {isHelpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-black/10 bg-card p-4 shadow-2xl dark:border-white/10">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">About This Page</p>
                <h3 className="mt-2 text-lg font-semibold">Student & Guardian Management</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsHelpOpen(false)}
                className="rounded-lg border border-black/10 px-3 py-1 text-sm font-semibold dark:border-white/15"
              >
                Close
              </button>
            </div>

            <div className="mt-4 space-y-4 text-sm text-muted">
              <div>
                <p className="font-semibold text-foreground">Add Students</p>
                <p className="mt-1">Create student profiles with their contact information, grade level, and registration numbers for easy management.</p>
              </div>
              <div>
                <p className="font-semibold text-foreground">Class Assignment</p>
                <p className="mt-1">Assign students to your classes and track which students are enrolled in each class with an organized list view.</p>
              </div>
              <div>
                <p className="font-semibold text-foreground">Guardian Profiles</p>
                <p className="mt-1">Create and manage guardian profiles linked to students for parent communication and contact purposes.</p>
              </div>
              <div>
                <p className="font-semibold text-foreground">How to Use</p>
                <ul className="mt-2 list-inside list-disc space-y-1">
                  <li>Click &ldquo;Add student&rdquo; to create a new student profile</li>
                  <li>Enter student details: name, grade, contact, and email</li>
                  <li>Filter students by name or grade using the filter options</li>
                  <li>View which classes each student is enrolled in</li>
                  <li>Use the pagination to navigate through your student list</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
