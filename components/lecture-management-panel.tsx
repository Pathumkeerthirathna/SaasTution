"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type ClassItem = {
  id: string;
  name: string;
  schedule: string;
};

type LectureNote = {
  id: string;
  title: string;
  fileUrl: string;
  kind: "NOTE" | "SUPPORTING_MATERIAL";
  mimeType: string;
  sizeBytes: number;
  downloadCount: number;
  lastDownloadedAt: string | null;
};

type LectureAssignment = {
  id: string;
  title: string;
  description: string;
  dueDate: string;
};

type LectureQuiz = {
  id: string;
  title: string;
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

type AssignmentFormState = {
  title: string;
  description: string;
  dueDate: string;
};

type QuizFormState = {
  title: string;
};

type NoteFormState = {
  title: string;
  kind: "NOTE" | "SUPPORTING_MATERIAL";
  file: File | null;
};

type LectureTab = "notes" | "assignments" | "quizzes";

const PAGE_SIZE = 6;
const OPTION_PAGE_SIZE = 50;

function formatBytes(bytes: number) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

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

  const [assignmentForms, setAssignmentForms] = useState<Record<string, AssignmentFormState>>({});
  const [quizForms, setQuizForms] = useState<Record<string, QuizFormState>>({});
  const [noteForms, setNoteForms] = useState<Record<string, NoteFormState>>({});

  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [openLectureTabs, setOpenLectureTabs] = useState<Record<string, LectureTab>>({});
  const [loadedSections, setLoadedSections] = useState<Record<string, Partial<Record<LectureTab, boolean>>>>({});
  const [notesByLecture, setNotesByLecture] = useState<Record<string, LectureNote[]>>({});
  const [assignmentsByLecture, setAssignmentsByLecture] = useState<Record<string, LectureAssignment[]>>({});
  const [quizzesByLecture, setQuizzesByLecture] = useState<Record<string, LectureQuiz[]>>({});
  const [isAddLecturePanelOpen, setIsAddLecturePanelOpen] = useState(false);

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

  function getAssignmentForm(lectureId: string): AssignmentFormState {
    return assignmentForms[lectureId] ?? {
      title: "",
      description: "",
      dueDate: "",
    };
  }

  function getQuizForm(lectureId: string): QuizFormState {
    return quizForms[lectureId] ?? {
      title: "",
    };
  }

  function getNoteForm(lectureId: string): NoteFormState {
    return noteForms[lectureId] ?? {
      title: "",
      kind: "NOTE",
      file: null,
    };
  }

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

  async function ensureSectionLoaded(lectureId: string, tab: LectureTab, forceReload = false) {
    const alreadyLoaded = loadedSections[lectureId]?.[tab];
    if (alreadyLoaded && !forceReload) {
      return;
    }

    const endpoint =
      tab === "notes"
        ? `/api/lectures/${lectureId}/notes`
        : tab === "assignments"
          ? `/api/lectures/${lectureId}/assignments`
          : `/api/lectures/${lectureId}/quizzes`;

    const response = await fetch(endpoint);
    const payload = (await response.json()) as {
      success: boolean;
      data?: LectureNote[] | LectureAssignment[] | LectureQuiz[];
    };

    if (!response.ok || !payload.success) {
      throw new Error(readApiError(payload, `Failed to load ${tab}.`));
    }

    if (tab === "notes") {
      setNotesByLecture((prev) => ({ ...prev, [lectureId]: (payload.data as LectureNote[]) ?? [] }));
    } else if (tab === "assignments") {
      setAssignmentsByLecture((prev) => ({ ...prev, [lectureId]: (payload.data as LectureAssignment[]) ?? [] }));
    } else {
      setQuizzesByLecture((prev) => ({ ...prev, [lectureId]: (payload.data as LectureQuiz[]) ?? [] }));
    }

    setLoadedSections((prev) => ({
      ...prev,
      [lectureId]: {
        ...prev[lectureId],
        [tab]: true,
      },
    }));
  }

  async function openLectureTab(lectureId: string, tab: LectureTab) {
    setOpenLectureTabs((prev) => ({ ...prev, [lectureId]: tab }));

    try {
      await ensureSectionLoaded(lectureId, tab);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : `Failed to load ${tab}.`);
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

  async function handleUploadNote(lectureId: string) {
    const form = getNoteForm(lectureId);
    const selectedFile = form.file;

    if (!selectedFile) {
      setErrorMessage("Please choose a file before uploading.");
      return;
    }

    await withSubmitState(async () => {
      const formData = new FormData();
      formData.set("title", form.title);
      formData.set("kind", form.kind);
      formData.set("file", selectedFile);

      const response = await fetch(`/api/lectures/${lectureId}/notes`, {
        method: "POST",
        body: formData,
      });

      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to upload file."));
      }

      setSuccessMessage(form.kind === "NOTE" ? "Lecture note uploaded." : "Supporting material uploaded.");
      setNoteForms((prev) => ({
        ...prev,
        [lectureId]: {
          title: "",
          kind: "NOTE",
          file: null,
        },
      }));
      await ensureSectionLoaded(lectureId, "notes", true);
      await loadLectures(page, filterClassId);
    });
  }

  async function handleUpdateNote(lectureId: string, note: LectureNote) {
    const nextTitle = window.prompt("Update file title", note.title)?.trim();
    if (!nextTitle) {
      return;
    }

    await withSubmitState(async () => {
      const response = await fetch(`/api/lectures/${lectureId}/notes/${note.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: nextTitle }),
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to update note."));
      }

      setSuccessMessage("File details updated successfully.");
      await ensureSectionLoaded(lectureId, "notes", true);
    });
  }

  async function handleDeleteNote(lectureId: string, note: LectureNote) {
    const confirmed = window.confirm(`Delete file "${note.title}"?`);
    if (!confirmed) {
      return;
    }

    await withSubmitState(async () => {
      const response = await fetch(`/api/lectures/${lectureId}/notes/${note.id}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to delete note."));
      }

      setSuccessMessage("File deleted successfully.");
      await ensureSectionLoaded(lectureId, "notes", true);
      await loadLectures(page, filterClassId);
    });
  }

  async function handleAddAssignment(lectureId: string) {
    const form = getAssignmentForm(lectureId);

    await withSubmitState(async () => {
      const response = await fetch(`/api/lectures/${lectureId}/assignments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(form),
      });

      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to add assignment."));
      }

      setSuccessMessage("Assignment added successfully.");
      setAssignmentForms((prev) => ({
        ...prev,
        [lectureId]: {
          title: "",
          description: "",
          dueDate: "",
        },
      }));
      await ensureSectionLoaded(lectureId, "assignments", true);
      await loadLectures(page, filterClassId);
    });
  }

  async function handleUpdateAssignment(lectureId: string, assignment: LectureAssignment) {
    const nextTitle = window.prompt("Update assignment title", assignment.title)?.trim();
    if (!nextTitle) {
      return;
    }

    await withSubmitState(async () => {
      const response = await fetch(`/api/lectures/${lectureId}/assignments/${assignment.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: nextTitle }),
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to update assignment."));
      }

      setSuccessMessage("Assignment updated successfully.");
      await ensureSectionLoaded(lectureId, "assignments", true);
    });
  }

  async function handleDeleteAssignment(lectureId: string, assignment: LectureAssignment) {
    const confirmed = window.confirm(`Delete assignment "${assignment.title}"?`);
    if (!confirmed) {
      return;
    }

    await withSubmitState(async () => {
      const response = await fetch(`/api/lectures/${lectureId}/assignments/${assignment.id}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to delete assignment."));
      }

      setSuccessMessage("Assignment deleted successfully.");
      await ensureSectionLoaded(lectureId, "assignments", true);
      await loadLectures(page, filterClassId);
    });
  }

  async function handleAddQuiz(lectureId: string) {
    const form = getQuizForm(lectureId);

    await withSubmitState(async () => {
      const response = await fetch(`/api/lectures/${lectureId}/quizzes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(form),
      });

      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to add quiz."));
      }

      setSuccessMessage("Quiz added successfully.");
      setQuizForms((prev) => ({
        ...prev,
        [lectureId]: {
          title: "",
        },
      }));
      await ensureSectionLoaded(lectureId, "quizzes", true);
      await loadLectures(page, filterClassId);
    });
  }

  async function handleUpdateQuiz(lectureId: string, quiz: LectureQuiz) {
    const nextTitle = window.prompt("Update quiz title", quiz.title)?.trim();
    if (!nextTitle) {
      return;
    }

    await withSubmitState(async () => {
      const response = await fetch(`/api/lectures/${lectureId}/quizzes/${quiz.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: nextTitle }),
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to update quiz."));
      }

      setSuccessMessage("Quiz updated successfully.");
      await ensureSectionLoaded(lectureId, "quizzes", true);
    });
  }

  async function handleDeleteQuiz(lectureId: string, quiz: LectureQuiz) {
    const confirmed = window.confirm(`Delete quiz "${quiz.title}"?`);
    if (!confirmed) {
      return;
    }

    await withSubmitState(async () => {
      const response = await fetch(`/api/lectures/${lectureId}/quizzes/${quiz.id}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to delete quiz."));
      }

      setSuccessMessage("Quiz deleted successfully.");
      await ensureSectionLoaded(lectureId, "quizzes", true);
      await loadLectures(page, filterClassId);
    });
  }

  return (
    <section className="mt-6 space-y-6">
      <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Lectures</h2>
            <p className="mt-1 text-sm text-muted">Page {page} of {totalPages}</p>
          </div>

          <div className="flex w-full flex-col items-stretch gap-2 lg:w-auto lg:items-end">
            <button
              type="button"
              onClick={() => setIsAddLecturePanelOpen(true)}
              className="inline-flex items-center justify-center rounded-xl bg-foreground px-4 py-2 text-sm font-semibold text-background"
            >
              Add lecture
            </button>

            <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-[1.2fr_1fr_auto]">
            <input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="Search lectures..."
              className="rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none dark:border-white/20 dark:bg-transparent"
            />
            <select
              value={filterClassId}
              onChange={(event) => setFilterClassId(event.target.value)}
              className="rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none dark:border-white/20 dark:bg-transparent"
            >
              <option value="">All classes</option>
              {classes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void loadLectures(1, filterClassId)}
              className="rounded-xl border border-black/15 px-4 py-2 text-sm font-semibold dark:border-white/20"
            >
              Apply
            </button>
            </div>
          </div>
        </div>

        {errorMessage ? (
          <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>
        ) : null}

        {successMessage ? (
          <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {successMessage}
          </p>
        ) : null}

        {isLoading ? <p className="mt-4 text-sm text-muted">Loading lectures...</p> : null}

        {!isLoading && filteredLectures.length === 0 ? (
          <p className="mt-4 text-sm text-muted">No lectures found for selected criteria.</p>
        ) : null}

        <div className="mt-4 space-y-4">
          {filteredLectures.map((lecture) => {
            const assignmentForm = getAssignmentForm(lecture.id);
            const quizForm = getQuizForm(lecture.id);
            const noteForm = getNoteForm(lecture.id);
            const activeTab = openLectureTabs[lecture.id] ?? null;
            const status = getLectureStatus(lecture.date);

            return (
              <div key={lecture.id} className="rounded-2xl border border-black/10 p-4 shadow-sm dark:border-white/10">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="flex gap-4">
                    <div className="h-24 w-24 shrink-0 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200" />
                    <div>
                      <p className="text-xl font-semibold">{lecture.title}</p>
                      <p className="mt-1 text-sm text-muted">
                        {new Date(lecture.date).toLocaleDateString()} • {new Date(lecture.date).toLocaleTimeString()} • {lecture.class.name}
                      </p>
                      <p className="mt-1 text-xs text-muted">{lecture.class.schedule}</p>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void openLectureTab(lecture.id, "notes")}
                          className={`rounded-lg border px-3 py-1 text-xs font-semibold ${
                            activeTab === "notes"
                              ? "border-foreground bg-foreground text-background"
                              : "border-black/15 dark:border-white/20"
                          }`}
                        >
                          Notes {lecture._count.notes}
                        </button>
                        <button
                          type="button"
                          onClick={() => void openLectureTab(lecture.id, "assignments")}
                          className={`rounded-lg border px-3 py-1 text-xs font-semibold ${
                            activeTab === "assignments"
                              ? "border-foreground bg-foreground text-background"
                              : "border-black/15 dark:border-white/20"
                          }`}
                        >
                          Assignments {lecture._count.assignments}
                        </button>
                        <button
                          type="button"
                          onClick={() => void openLectureTab(lecture.id, "quizzes")}
                          className={`rounded-lg border px-3 py-1 text-xs font-semibold ${
                            activeTab === "quizzes"
                              ? "border-foreground bg-foreground text-background"
                              : "border-black/15 dark:border-white/20"
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
                        className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold dark:border-white/20"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => void handleDeleteLecture(lecture)}
                        className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>

                {activeTab === "notes" ? (
                  <div className="mt-4 rounded-xl border border-black/10 p-3 dark:border-white/10">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">Notes & materials</p>

                    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr]">
                      <input
                        value={noteForm.title}
                        onChange={(event) =>
                          setNoteForms((prev) => ({
                            ...prev,
                            [lecture.id]: {
                              ...noteForm,
                              title: event.target.value,
                            },
                          }))
                        }
                        placeholder="File title"
                        className="rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
                      />
                      <select
                        value={noteForm.kind}
                        onChange={(event) =>
                          setNoteForms((prev) => ({
                            ...prev,
                            [lecture.id]: {
                              ...noteForm,
                              kind: event.target.value as "NOTE" | "SUPPORTING_MATERIAL",
                            },
                          }))
                        }
                        className="rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
                      >
                        <option value="NOTE">Note</option>
                        <option value="SUPPORTING_MATERIAL">Supporting material</option>
                      </select>
                    </div>
                    <input
                      type="file"
                      onChange={(event) => {
                        const file = event.target.files?.[0] ?? null;
                        setNoteForms((prev) => ({
                          ...prev,
                          [lecture.id]: {
                            ...noteForm,
                            file,
                          },
                        }));
                      }}
                      className="mt-2 block w-full text-xs"
                    />
                    <button
                      type="button"
                      disabled={isSubmitting || !noteForm.title || !noteForm.file}
                      onClick={() => void handleUploadNote(lecture.id)}
                      className="mt-2 rounded-lg bg-foreground px-3 py-2 text-xs font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Upload
                    </button>

                    <div className="mt-3 space-y-2">
                      {(notesByLecture[lecture.id] ?? []).map((note) => (
                        <div key={note.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-black/10 px-3 py-2 text-xs dark:border-white/10">
                          <div>
                            <p className="font-semibold">{note.title}</p>
                            <p className="text-muted">{note.kind} • {formatBytes(note.sizeBytes)} • Downloads: {note.downloadCount}</p>
                          </div>
                          <div className="flex gap-2">
                            <a href={`/api/lectures/notes/${note.id}/download`} className="rounded-lg border border-black/15 px-3 py-1.5 font-semibold dark:border-white/20">
                              Download
                            </a>
                            <button
                              type="button"
                              disabled={isSubmitting}
                              onClick={() => void handleUpdateNote(lecture.id, note)}
                              className="rounded-lg border border-black/15 px-3 py-1.5 font-semibold dark:border-white/20"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              disabled={isSubmitting}
                              onClick={() => void handleDeleteNote(lecture.id, note)}
                              className="rounded-lg border border-red-300 px-3 py-1.5 font-semibold text-red-700"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {activeTab === "assignments" ? (
                  <div className="mt-4 rounded-xl border border-black/10 p-3 dark:border-white/10">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">Assignments</p>
                    <input
                      value={assignmentForm.title}
                      onChange={(event) =>
                        setAssignmentForms((prev) => ({
                          ...prev,
                          [lecture.id]: {
                            ...assignmentForm,
                            title: event.target.value,
                          },
                        }))
                      }
                      placeholder="Assignment title"
                      className="mt-2 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
                    />
                    <textarea
                      value={assignmentForm.description}
                      onChange={(event) =>
                        setAssignmentForms((prev) => ({
                          ...prev,
                          [lecture.id]: {
                            ...assignmentForm,
                            description: event.target.value,
                          },
                        }))
                      }
                      rows={3}
                      placeholder="Assignment description"
                      className="mt-2 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
                    />
                    <input
                      type="datetime-local"
                      value={assignmentForm.dueDate}
                      onChange={(event) =>
                        setAssignmentForms((prev) => ({
                          ...prev,
                          [lecture.id]: {
                            ...assignmentForm,
                            dueDate: event.target.value,
                          },
                        }))
                      }
                      className="mt-2 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
                    />
                    <button
                      type="button"
                      disabled={isSubmitting || !assignmentForm.title || !assignmentForm.description || !assignmentForm.dueDate}
                      onClick={() => void handleAddAssignment(lecture.id)}
                      className="mt-2 rounded-lg bg-foreground px-3 py-2 text-xs font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Add assignment
                    </button>

                    <div className="mt-3 space-y-2">
                      {(assignmentsByLecture[lecture.id] ?? []).map((assignment) => (
                        <div key={assignment.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-black/10 px-3 py-2 text-xs dark:border-white/10">
                          <div>
                            <p className="font-semibold">{assignment.title}</p>
                            <p className="text-muted">Due: {new Date(assignment.dueDate).toLocaleString()}</p>
                          </div>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={isSubmitting}
                              onClick={() => void handleUpdateAssignment(lecture.id, assignment)}
                              className="rounded-lg border border-black/15 px-3 py-1.5 font-semibold dark:border-white/20"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              disabled={isSubmitting}
                              onClick={() => void handleDeleteAssignment(lecture.id, assignment)}
                              className="rounded-lg border border-red-300 px-3 py-1.5 font-semibold text-red-700"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {activeTab === "quizzes" ? (
                  <div className="mt-4 rounded-xl border border-black/10 p-3 dark:border-white/10">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">Quizzes</p>
                    <input
                      value={quizForm.title}
                      onChange={(event) =>
                        setQuizForms((prev) => ({
                          ...prev,
                          [lecture.id]: {
                            ...quizForm,
                            title: event.target.value,
                          },
                        }))
                      }
                      placeholder="Quiz title"
                      className="mt-2 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
                    />
                    <button
                      type="button"
                      disabled={isSubmitting || !quizForm.title}
                      onClick={() => void handleAddQuiz(lecture.id)}
                      className="mt-2 rounded-lg bg-foreground px-3 py-2 text-xs font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Add quiz
                    </button>

                    <div className="mt-3 space-y-2">
                      {(quizzesByLecture[lecture.id] ?? []).map((quiz) => (
                        <div key={quiz.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-black/10 px-3 py-2 text-xs dark:border-white/10">
                          <p className="font-semibold">{quiz.title}</p>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={isSubmitting}
                              onClick={() => void handleUpdateQuiz(lecture.id, quiz)}
                              className="rounded-lg border border-black/15 px-3 py-1.5 font-semibold dark:border-white/20"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              disabled={isSubmitting}
                              onClick={() => void handleDeleteQuiz(lecture.id, quiz)}
                              className="rounded-lg border border-red-300 px-3 py-1.5 font-semibold text-red-700"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex items-center justify-between">
          <button
            type="button"
            disabled={page <= 1 || isLoading}
            onClick={() => void loadLectures(page - 1, filterClassId)}
            className="rounded-xl border border-black/15 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/20"
          >
            Previous
          </button>

          <button
            type="button"
            disabled={page >= totalPages || isLoading}
            onClick={() => void loadLectures(page + 1, filterClassId)}
            className="rounded-xl border border-black/15 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/20"
          >
            Next
          </button>
        </div>
      </article>

      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity ${
          isAddLecturePanelOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setIsAddLecturePanelOpen(false)}
        aria-hidden
      />

      <aside
        className={`fixed right-0 top-0 z-50 h-full w-full max-w-md transform border-l border-black/10 bg-card p-5 shadow-2xl transition-transform duration-200 dark:border-white/10 sm:p-6 ${
          isAddLecturePanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!isAddLecturePanelOpen}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Add lecture</h2>
            <p className="mt-1 text-sm text-muted">Create lecture entries with class and schedule date.</p>
          </div>

          <button
            type="button"
            onClick={() => setIsAddLecturePanelOpen(false)}
            className="rounded-lg border border-black/15 px-3 py-1 text-sm font-semibold dark:border-white/20"
          >
            Close
          </button>
        </div>

        <form className="mt-6 space-y-3" onSubmit={handleCreateLecture}>
          <select
            value={createLectureForm.classId}
            onChange={(event) => setCreateLectureForm((prev) => ({ ...prev, classId: event.target.value }))}
            className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none dark:border-white/20 dark:bg-transparent"
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
            className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none dark:border-white/20 dark:bg-transparent"
          />

          <input
            type="datetime-local"
            value={createLectureForm.date}
            onChange={(event) => setCreateLectureForm((prev) => ({ ...prev, date: event.target.value }))}
            className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none dark:border-white/20 dark:bg-transparent"
          />

          <button
            type="submit"
            disabled={isSubmitting || !createLectureForm.classId || !createLectureForm.title || !createLectureForm.date}
            className="w-full rounded-xl bg-foreground px-4 py-2.5 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? "Saving..." : "Add lecture"}
          </button>
        </form>
      </aside>
    </section>
  );
}
