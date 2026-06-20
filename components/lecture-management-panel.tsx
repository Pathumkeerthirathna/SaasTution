"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  Calendar,
  ChevronDown,
  CircleHelp,
  Clock3,
  FileText,
  Filter,
  GraduationCap,
  Plus,
  Search,
  SquarePen,
  Trash2,
} from "lucide-react";
import { LectureQuizPanel } from "@/components/lecture-quiz-panel";
import { LectureAssignmentPanel } from "@/components/lecture-assignment-panel";
import { LectureNotePanel } from "@/components/lecture-note-panel";

type ClassItem = {
  id: string;
  name: string;
  schedule: string;
};

type LectureItem = {
  id: string;
  title: string;
  date: string;
  createdAt: string;
  class: {
    id: string;
    name: string;
    schedule: string;
  };
  _count: {
    notes: number;
    assignments: number;
    quizzes: number;
  };
};

type LectureTab = "notes" | "assignments" | "quizzes";

type QuizPanelLecture = {
  id: string;
  title: string;
  date: string;
  class: {
    id: string;
    name: string;
    schedule: string;
  };
};

type AssignmentPanelLecture = {
  id: string;
  title: string;
  date: string;
  class: {
    id: string;
    name: string;
    schedule: string;
  };
};

type NotePanelLecture = {
  id: string;
  title: string;
  date: string;
  class: {
    id: string;
    name: string;
    schedule: string;
  };
};

const PAGE_SIZE = 6;
const OPTION_PAGE_SIZE = 50;

function readApiError(payload: unknown, fallbackMessage: string) {
  if (!payload || typeof payload !== "object") {
    return fallbackMessage;
  }

  const typed = payload as { error?: { message?: string }; message?: string };
  return typed.error?.message ?? typed.message ?? fallbackMessage;
}

function getLectureStatus(dateValue: string) {
  const lectureDate = new Date(dateValue);
  const now = new Date();

  if (lectureDate.getTime() < now.getTime()) {
    return { label: "Completed", tone: "bg-emerald-100 text-emerald-700" };
  }

  const hoursDiff = (lectureDate.getTime() - now.getTime()) / (1000 * 60 * 60);

  if (hoursDiff <= 48) {
    return { label: "Upcoming", tone: "bg-blue-100 text-blue-700" };
  }

  return { label: "Scheduled", tone: "bg-slate-100 text-slate-700" };
}

export function LectureManagementPanel() {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [lectures, setLectures] = useState<LectureItem[]>([]);
  const [filterClassId, setFilterClassId] = useState("");
  const [searchText, setSearchText] = useState("");

  const [createLectureForm, setCreateLectureForm] = useState({
    classId: "",
    title: "",
    date: "",
  });

  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [isAddLecturePanelOpen, setIsAddLecturePanelOpen] = useState(false);
  const [isQuizPanelOpen, setIsQuizPanelOpen] = useState(false);
  const [quizPanelLecture, setQuizPanelLecture] = useState<QuizPanelLecture | null>(null);
  const [isAssignmentPanelOpen, setIsAssignmentPanelOpen] = useState(false);
  const [assignmentPanelLecture, setAssignmentPanelLecture] = useState<AssignmentPanelLecture | null>(null);
  const [isNotePanelOpen, setIsNotePanelOpen] = useState(false);
  const [notePanelLecture, setNotePanelLecture] = useState<NotePanelLecture | null>(null);
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  const filteredLectures = useMemo(() => {
    const text = searchText.trim().toLowerCase();
    if (!text) {
      return lectures;
    }

    return lectures.filter((lecture) => lecture.title.toLowerCase().includes(text));
  }, [lectures, searchText]);

  const loadClasses = useCallback(async () => {
    const response = await fetch(`/api/classes?page=1&pageSize=${OPTION_PAGE_SIZE}`);
    const payload = (await response.json()) as {
      success: boolean;
      data?: ClassItem[];
    };

    if (!response.ok || !payload.success) {
      throw new Error(readApiError(payload, "Failed to load classes."));
    }

    return payload.data ?? [];
  }, []);

  const loadLectures = useCallback(async (nextPage = 1, classId = "") => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const query = new URLSearchParams({
        page: String(nextPage),
        pageSize: String(PAGE_SIZE),
      });

      if (classId) {
        query.set("classId", classId);
      }

      const response = await fetch(`/api/lectures?${query.toString()}`);
      const payload = (await response.json()) as {
        success: boolean;
        data?: LectureItem[];
        pagination?: {
          page: number;
          totalPages: number;
        };
      };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to load lectures."));
      }

      setLectures(payload.data ?? []);
      setPage(payload.pagination?.page ?? nextPage);
      setTotalPages(payload.pagination?.totalPages ?? 1);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load lectures.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    async function bootstrap() {
      try {
        const classList = await loadClasses();
        setClasses(classList);

        if (classList.length > 0) {
          setCreateLectureForm((prev) => ({ ...prev, classId: classList[0].id }));
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to load class options.");
      }

      await loadLectures(1, "");
    }

    void bootstrap();
  }, [loadClasses, loadLectures]);

  async function withSubmitState(action: () => Promise<void>) {
    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      await action();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function openLectureTab(lectureId: string, tab: LectureTab) {
    if (tab === "notes") {
      const lecture = lectures.find((item) => item.id === lectureId);

      if (lecture) {
        setNotePanelLecture({
          id: lecture.id,
          title: lecture.title,
          date: lecture.date,
          class: lecture.class,
        });
        setIsNotePanelOpen(true);
      }

      return;
    }

    if (tab === "assignments") {
      const lecture = lectures.find((item) => item.id === lectureId);

      if (lecture) {
        setAssignmentPanelLecture({
          id: lecture.id,
          title: lecture.title,
          date: lecture.date,
          class: lecture.class,
        });
        setIsAssignmentPanelOpen(true);
      }

      return;
    }

    if (tab === "quizzes") {
      const lecture = lectures.find((item) => item.id === lectureId);

      if (lecture) {
        setQuizPanelLecture({
          id: lecture.id,
          title: lecture.title,
          date: lecture.date,
          class: lecture.class,
        });
        setIsQuizPanelOpen(true);
      }

      return;
    }
  }

  async function handleCreateLecture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await withSubmitState(async () => {
      const response = await fetch("/api/lectures", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(createLectureForm),
      });

      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to create lecture."));
      }

      setSuccessMessage("Lecture created successfully.");
      setCreateLectureForm((prev) => ({
        ...prev,
        title: "",
        date: "",
      }));
      setIsAddLecturePanelOpen(false);
      await loadLectures(1, filterClassId);
    });
  }

  async function handleUpdateLecture(lecture: LectureItem) {
    const nextTitle = window.prompt("Update lecture title", lecture.title)?.trim();
    if (!nextTitle) {
      return;
    }

    await withSubmitState(async () => {
      const response = await fetch(`/api/lectures/${lecture.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: nextTitle }),
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to update lecture."));
      }

      setSuccessMessage("Lecture updated successfully.");
      await loadLectures(page, filterClassId);
    });
  }

  async function handleDeleteLecture(lecture: LectureItem) {
    const confirmed = window.confirm(`Delete lecture "${lecture.title}" and all linked materials?`);
    if (!confirmed) {
      return;
    }

    await withSubmitState(async () => {
      const response = await fetch(`/api/lectures/${lecture.id}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to delete lecture."));
      }

      setSuccessMessage("Lecture deleted successfully.");
      await loadLectures(page, filterClassId);
    });
  }

  return (
    <section className="space-y-6">
      <article className="surface-panel border border-brand-100 p-6 sm:p-7">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-4">
            <span className="page-header-icon">
              <FileText size={28} />
            </span>
            <div>
              <h2 className="page-title">Lectures</h2>
              <p className="page-subtitle">Create lectures, manage files, assignments, and quizzes.</p>
              <p className="mt-5 text-sm font-medium text-slate-600">Page {page} of {totalPages}</p>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
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
              onClick={() => setIsAddLecturePanelOpen(true)}
              className="btn-primary gap-2"
            >
              <Plus size={15} />
              Add lecture
            </button>
          </div>
        </div>

        <div className="filter-shell mt-6">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.8fr_0.8fr_auto]">
            <div className="relative">
              <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Search lectures..."
                className="control-input h-14 pl-11 text-base"
              />
            </div>
            <div className="relative">
              <GraduationCap size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
              <ChevronDown size={16} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-muted" />
              <select
                value={filterClassId}
                onChange={(event) => setFilterClassId(event.target.value)}
                className="control-select h-14 appearance-none pl-11 pr-12 text-base"
              >
                <option value="">All classes</option>
                {classes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={() => void loadLectures(1, filterClassId)}
              className="btn-secondary h-14 gap-2 px-5"
            >
              <Filter size={15} />
              Apply
            </button>
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

        {isLoading ? <p className="mt-4 text-sm text-muted">Loading lectures...</p> : null}

        {!isLoading && filteredLectures.length === 0 ? (
          <p className="mt-4 text-sm text-muted">No lectures found for selected criteria.</p>
        ) : null}

        <div className="mt-5 space-y-4">
          {filteredLectures.map((lecture) => {
            const status = getLectureStatus(lecture.date);

            return (
              <div key={lecture.id} className="surface-panel border border-brand-100 p-5 sm:p-6">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                  <div className="flex gap-4">
                    <div className="inline-flex h-28 w-28 shrink-0 items-center justify-center rounded-3xl bg-brand-50 text-brand-700 shadow-soft">
                      <FileText size={36} />
                    </div>
                    <div>
                      <p className="text-2xl font-semibold tracking-tight text-slate-900">{lecture.title}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-600">
                        <span className="inline-flex items-center gap-1.5"><Calendar size={14} />{new Date(lecture.date).toLocaleDateString()}</span>
                        <span className="inline-flex items-center gap-1.5"><Clock3 size={14} />{new Date(lecture.date).toLocaleTimeString()}</span>
                        <span className="inline-flex items-center gap-1.5"><GraduationCap size={14} />{lecture.class.name}</span>
                      </div>
                      <p className="mt-2 text-sm text-muted">{lecture.class.schedule}</p>

                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void openLectureTab(lecture.id, "notes")}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${
                            isNotePanelOpen && notePanelLecture?.id === lecture.id
                              ? "border-brand-700 bg-brand-700 text-white"
                              : "border-brand-100 bg-white text-slate-700"
                          }`}
                        >
                          <FileText size={12} />
                          Notes {lecture._count.notes}
                        </button>
                        <button
                          type="button"
                          onClick={() => void openLectureTab(lecture.id, "assignments")}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${
                            isAssignmentPanelOpen && assignmentPanelLecture?.id === lecture.id
                              ? "border-brand-700 bg-brand-700 text-white"
                              : "border-brand-100 bg-white text-slate-700"
                          }`}
                        >
                          Assignments {lecture._count.assignments}
                        </button>
                        <button
                          type="button"
                          onClick={() => void openLectureTab(lecture.id, "quizzes")}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${
                            isQuizPanelOpen && quizPanelLecture?.id === lecture.id
                              ? "border-brand-700 bg-brand-700 text-white"
                              : "border-brand-100 bg-white text-slate-700"
                          }`}
                        >
                          Quizzes {lecture._count.quizzes}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col items-start gap-3 lg:items-end">
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${status.tone}`}>{status.label}</span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => void handleUpdateLecture(lecture)}
                        className="btn-secondary gap-2 px-3 py-2 text-xs"
                      >
                        <SquarePen size={12} />
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => void handleDeleteLecture(lecture)}
                        className="btn-danger gap-2 px-3 py-2 text-xs"
                      >
                        <Trash2 size={12} />
                        Delete
                      </button>
                    </div>
                  </div>
                </div>

              </div>
            );
          })}
        </div>

        <div className="surface-soft mt-5 flex flex-col gap-3 rounded-3xl p-4 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            className="btn-secondary gap-2 w-fit"
            disabled
          >
            6 per page
            <ChevronDown size={13} />
          </button>

          <div className="flex items-center justify-center text-sm font-medium text-slate-500">Page {page} of {totalPages}</div>

          <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={page <= 1 || isLoading}
            onClick={() => void loadLectures(page - 1, filterClassId)}
            className="btn-secondary disabled:cursor-not-allowed disabled:opacity-60"
          >
            Previous
          </button>

          <button
            type="button"
            disabled={page >= totalPages || isLoading}
            onClick={() => void loadLectures(page + 1, filterClassId)}
            className="btn-secondary disabled:cursor-not-allowed disabled:opacity-60"
          >
            Next
          </button>
          </div>
        </div>
      </article>

      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity ${
          isAddLecturePanelOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setIsAddLecturePanelOpen(false)}
        aria-hidden
      />

      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity ${
          isQuizPanelOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setIsQuizPanelOpen(false)}
        aria-hidden
      />

      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity ${
          isAssignmentPanelOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setIsAssignmentPanelOpen(false)}
        aria-hidden
      />

      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity ${
          isNotePanelOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setIsNotePanelOpen(false)}
        aria-hidden
      />

      {isHelpOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-3xl rounded-3xl border border-brand-100 bg-white/95 p-6 shadow-panel backdrop-blur">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">About This Page</p>
                <h2 className="mt-2 text-xl font-semibold text-slate-900">Lecture Management</h2>
                <p className="mt-2 text-sm text-muted">
                  Manage lectures, files, assignments, and quizzes. Create lectures with dates, upload notes and supporting materials, and add assignments and quizzes for each lecture.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsHelpOpen(false)}
                className="btn-secondary px-3 py-1.5 text-xs"
              >
                Close
              </button>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-brand-100 bg-brand-50/50 p-4 shadow-soft">
                <p className="text-sm font-semibold text-slate-900">What you can do here</p>
                <ul className="mt-2 space-y-2 text-sm text-muted">
                  <li>Create and schedule lectures for each class.</li>
                  <li>Upload notes and supporting materials for students.</li>
                  <li>Add and manage assignments linked to each lecture.</li>
                  <li>Create quizzes and manage lecture learning content in one place.</li>
                </ul>
              </div>

              <div className="rounded-2xl border border-brand-100 bg-brand-50/50 p-4 shadow-soft">
                <p className="text-sm font-semibold text-slate-900">How to use this page</p>
                <ul className="mt-2 space-y-2 text-sm text-muted">
                  <li>Use the class filter and search to find lectures quickly.</li>
                  <li>Use Add lecture to create a new scheduled lecture.</li>
                  <li>Open Notes, Assignments, or Quizzes from each lecture card.</li>
                  <li>Keep everything for a lecture organized under one record.</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <aside
        className={`drawer-panel transform transition-transform duration-200 ${
          isAddLecturePanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!isAddLecturePanelOpen}
      >
        <div className="flex items-start justify-between gap-4 border-b border-brand-100 pb-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Add lecture</h2>
            <p className="mt-1 text-sm text-muted">Create lecture entries with class and schedule date.</p>
          </div>

          <button
            type="button"
            onClick={() => setIsAddLecturePanelOpen(false)}
            className="btn-secondary"
          >
            Close
          </button>
        </div>

        <form className="mt-6 space-y-3" onSubmit={handleCreateLecture}>
          <select
            value={createLectureForm.classId}
            onChange={(event) => setCreateLectureForm((prev) => ({ ...prev, classId: event.target.value }))}
            className="control-select"
          >
            <option value="">Select class</option>
            {classes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.schedule})
              </option>
            ))}
          </select>

          <input
            value={createLectureForm.title}
            onChange={(event) => setCreateLectureForm((prev) => ({ ...prev, title: event.target.value }))}
            placeholder="Lecture title"
            className="control-input"
          />

          <input
            type="datetime-local"
            value={createLectureForm.date}
            onChange={(event) => setCreateLectureForm((prev) => ({ ...prev, date: event.target.value }))}
            className="control-input"
          />

          <button
            type="submit"
            disabled={isSubmitting || !createLectureForm.classId || !createLectureForm.title || !createLectureForm.date}
            className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? "Saving..." : "Add lecture"}
          </button>
        </form>
      </aside>

      <aside
        className={`fixed inset-0 z-50 transform overflow-y-auto bg-white shadow-2xl transition-transform duration-200 lg:left-auto lg:w-[94vw] lg:max-w-[1400px] lg:border-l lg:border-brand-100 ${
          isQuizPanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!isQuizPanelOpen}
      >
        <div className="sticky top-0 z-10 border-b border-brand-100 bg-white/95 px-4 py-4 backdrop-blur sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Lecture quizzes</h2>
              {quizPanelLecture ? (
                <p className="mt-1 text-sm text-muted">
                  {quizPanelLecture.title} • {quizPanelLecture.class.name} • {new Date(quizPanelLecture.date).toLocaleString()}
                </p>
              ) : (
                <p className="mt-1 text-sm text-muted">Select a lecture card and open Quizzes to manage quiz content.</p>
              )}
            </div>

            <button
              type="button"
              onClick={() => setIsQuizPanelOpen(false)}
              className="btn-secondary"
            >
              Close
            </button>
          </div>
        </div>

        <div className="px-4 pb-6 pt-4 sm:px-6">
          {quizPanelLecture ? (
            <LectureQuizPanel lectureId={quizPanelLecture.id} onChanged={() => loadLectures(page, filterClassId)} />
          ) : null}
        </div>
      </aside>

      <aside
        className={`fixed inset-0 z-50 transform overflow-y-auto bg-white shadow-2xl transition-transform duration-200 lg:left-auto lg:w-[94vw] lg:max-w-[1300px] lg:border-l lg:border-brand-100 ${
          isAssignmentPanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!isAssignmentPanelOpen}
      >
        <div className="sticky top-0 z-10 border-b border-brand-100 bg-white/95 px-4 py-4 backdrop-blur sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Lecture assignments</h2>
              {assignmentPanelLecture ? (
                <p className="mt-1 text-sm text-muted">
                  {assignmentPanelLecture.title} • {assignmentPanelLecture.class.name} • {new Date(assignmentPanelLecture.date).toLocaleString()}
                </p>
              ) : (
                <p className="mt-1 text-sm text-muted">Select a lecture card and open Assignments to manage assignment content.</p>
              )}
            </div>

            <button
              type="button"
              onClick={() => setIsAssignmentPanelOpen(false)}
              className="btn-secondary"
            >
              Close
            </button>
          </div>
        </div>

        <div className="px-4 pb-6 pt-4 sm:px-6">
          {assignmentPanelLecture ? (
            <LectureAssignmentPanel
              lectureId={assignmentPanelLecture.id}
              onChanged={() => loadLectures(page, filterClassId)}
            />
          ) : null}
        </div>
      </aside>

      <aside
        className={`fixed inset-0 z-50 transform overflow-y-auto bg-white shadow-2xl transition-transform duration-200 lg:left-auto lg:w-[94vw] lg:max-w-[1300px] lg:border-l lg:border-brand-100 ${
          isNotePanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!isNotePanelOpen}
      >
        <div className="sticky top-0 z-10 border-b border-brand-100 bg-white/95 px-4 py-4 backdrop-blur sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Lecture notes</h2>
              {notePanelLecture ? (
                <p className="mt-1 text-sm text-muted">
                  {notePanelLecture.title} • {notePanelLecture.class.name} • {new Date(notePanelLecture.date).toLocaleString()}
                </p>
              ) : (
                <p className="mt-1 text-sm text-muted">Select a lecture card and open Notes to manage files.</p>
              )}
            </div>

            <button
              type="button"
              onClick={() => setIsNotePanelOpen(false)}
              className="btn-secondary"
            >
              Close
            </button>
          </div>
        </div>

        <div className="px-4 pb-6 pt-4 sm:px-6">
          {notePanelLecture ? (
            <LectureNotePanel lectureId={notePanelLecture.id} onChanged={() => loadLectures(page, filterClassId)} />
          ) : null}
        </div>
      </aside>
    </section>
  );
}
