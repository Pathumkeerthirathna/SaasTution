"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  CircleHelp,
  Eye,
  Filter,
  GraduationCap,
  Plus,
  Search,
  Users,
} from "lucide-react";

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
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute -left-28 -top-24 h-72 w-72 rounded-full bg-brand-100 blur-3xl" />
      <div className="pointer-events-none absolute -right-24 top-14 h-72 w-72 rounded-full bg-cyan-100 blur-3xl" />

      <article className="panel-shell relative space-y-6">
        <div className="hero-shell">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-4">
              <span className="inline-flex h-14 w-14 items-center justify-center rounded-3xl bg-brand-100 text-brand-700 shadow-soft">
                <GraduationCap size={24} />
              </span>
              <div>
                <h2 className="text-4xl font-semibold tracking-tight text-slate-900">Student list</h2>
                <p className="mt-2 text-2xl text-muted">View and manage all students in your institution.</p>
                <p className="mt-6">
                  <span className="metric-badge">Page {page} of {totalPages}</span>
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setIsHelpOpen(true)}
                className="btn-secondary gap-2"
              >
                <CircleHelp size={15} />
                Help
              </button>
              <button
                type="button"
                onClick={() => setIsAddPanelOpen(true)}
                className="btn-primary gap-2"
              >
                <Plus size={15} />
                Add student
              </button>
            </div>
          </div>
        </div>

        <div className="filter-shell">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="relative">
              <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={filters.name}
                onChange={(event) => setFilters((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="Filter by student name..."
                className="control-input h-14 pl-12 text-base"
              />
            </div>

            <div className="relative">
              <BookOpen size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
              <ChevronDown size={16} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-muted" />
              <select
                value={filters.grade}
                onChange={(event) =>
                  setFilters((prev) => ({
                    ...prev,
                    grade: event.target.value as "" | (typeof GRADE_OPTIONS)[number],
                  }))
                }
                className="control-select h-14 appearance-none pl-12 pr-12 text-base"
              >
                <option value="">Filter by grade</option>
                {GRADE_OPTIONS.map((grade) => (
                  <option key={grade} value={grade}>
                    {formatGradeLabel(grade)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={isLoadingList}
                onClick={() => void loadStudentList(1, filters)}
                className="btn-primary gap-2"
              >
                <Filter size={14} />
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

            <span className="metric-badge">
              <Users size={14} />
              {students.length} Student{students.length === 1 ? "" : "s"} found
            </span>
          </div>
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

        <div className="table-wrap mt-6 rounded-3xl border-none shadow-card">
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
                  <td className="px-4 py-4 font-semibold text-foreground">
                    <span className="rounded-xl bg-brand-50 px-3 py-1 text-brand-700">{student.registrationNumber ?? "-"}</span>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-3">
                      <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-700">
                        {student.name.slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <p className="font-semibold text-foreground">{student.name}</p>
                        <span className="mt-1 inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Active</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-muted">
                    <span className="rounded-xl bg-violet-100 px-2.5 py-1 text-xs font-semibold text-violet-700">{formatGradeLabel(student.grade)}</span>
                  </td>
                  <td className="px-4 py-3 text-muted">{student.contact01 || "-"}</td>
                  <td className="px-4 py-3 text-muted">{student.contact02 || "-"}</td>
                  <td className="px-4 py-3 text-muted">{student.email || "-"}</td>
                  <td className="px-4 py-3 text-muted">
                    {student.classes.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {student.classes.map((classItem) => (
                          <span
                            key={classItem.id}
                            className="rounded-full border border-brand-100 bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700"
                          >
                            <span className="inline-flex items-center gap-1"><BookOpen size={11} />{classItem.name}</span>
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
                      className="btn-ghost gap-1.5 px-3 py-1.5 text-xs"
                    >
                      <Eye size={12} />
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="surface-soft mt-6 flex flex-col gap-3 rounded-3xl p-4 sm:flex-row sm:items-center sm:justify-between">
          <button type="button" className="btn-ghost w-fit gap-2" disabled>
            10 per page
            <ChevronDown size={13} />
          </button>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
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
            className="btn-ghost"
          >
            Next
          </button>
          </div>
        </div>
      </article>

      <button
        type="button"
        aria-label="Close add student panel"
        onClick={() => setIsAddPanelOpen(false)}
        className={`fixed inset-0 z-40 bg-black/40 transition ${isAddPanelOpen ? "visible opacity-100" : "invisible opacity-0"}`}
      />

      <aside
        className={`drawer-panel transition-transform duration-300 ${
          isAddPanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="sticky top-0 z-10 -mx-6 mb-6 border-b border-brand-200 bg-white/90 px-6 pb-4 pt-1 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-xl font-semibold">Add student</h3>
              <p className="mt-1 text-sm text-muted">Create student with grade, contacts, and email.</p>
            </div>
            <button
              type="button"
              onClick={() => setIsAddPanelOpen(false)}
              className="btn-ghost"
            >
              Close
            </button>
          </div>
        </div>

        <form className="space-y-4" onSubmit={handleCreateStudent}>
          <input
            required
            value={studentForm.name}
            onChange={(event) => setStudentForm((prev) => ({ ...prev, name: event.target.value }))}
            className="control-input"
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
            className="control-select"
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
            className="control-input"
            placeholder="Contact 01"
          />
          <input
            required
            value={studentForm.contact02}
            onChange={(event) => setStudentForm((prev) => ({ ...prev, contact02: event.target.value }))}
            className="control-input"
            placeholder="Contact 02"
          />
          <input
            type="email"
            required
            value={studentForm.email}
            onChange={(event) => setStudentForm((prev) => ({ ...prev, email: event.target.value }))}
            className="control-input"
            placeholder="Email"
          />
          <button
            type="submit"
            disabled={isSubmitting}
            className="btn-primary w-full"
          >
            {isSubmitting ? "Saving..." : "Add student"}
          </button>
        </form>
      </aside>

      {isHelpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-2xl rounded-3xl border border-brand-200 bg-white/95 p-6 shadow-panel backdrop-blur">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">About This Page</p>
                <h3 className="mt-2 text-lg font-semibold">Student & Guardian Management</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsHelpOpen(false)}
                className="btn-secondary"
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
