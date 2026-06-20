"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  BookOpen,
  Calendar,
  ChevronRight,
  Clock3,
  Mail,
  Phone,
  Plus,
  Sparkles,
  User,
  Users,
} from "lucide-react";

type ClassItem = {
  id: string;
  name: string;
  schedule: string;
};

export type StudentProfile = {
  id: string;
  name: string;
  grade: string | null;
  contact01: string | null;
  contact02: string | null;
  email: string | null;
  registrationNumber: string | null;
  createdAt: string;
  classes: {
    id: string;
    classId: string;
    name: string;
    schedule: string;
    assignedAt: string;
  }[];
  assignmentHistory: {
    id: string;
    classId: string;
    name: string;
    schedule: string;
    isActive: boolean;
    assignedAt: string;
    removedAt: string | null;
    removeReason: string | null;
  }[];
  guardians: {
    id: string;
    name: string;
    relation: string;
    phone: string;
    email: string | null;
  }[];
};



type ApiError = {
  message?: string;
};

type ProfileTab = "overview" | "classes" | "guardians";

const OPTION_PAGE_SIZE = 100;
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

function formatDate(value: string | null) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString();
}

export function StudentProfilePage({ studentId }: { studentId: string }) {
  const [classOptions, setClassOptions] = useState<ClassItem[]>([]);
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [assignClassId, setAssignClassId] = useState("");
  const [guardianForm, setGuardianForm] = useState({
    name: "",
    relation: "",
    phone: "",
  });
  const [studentForm, setStudentForm] = useState({
    name: "",
    grade: "",
    contact01: "",
    contact02: "",
    email: "",
  });
  const [guardianDrafts, setGuardianDrafts] = useState<
    Record<string, { name: string; relation: string; phone: string }>
  >({});
  const [removeReasonByClassId, setRemoveReasonByClassId] = useState<Record<string, string>>({});

  const [activeTab, setActiveTab] = useState<ProfileTab>("overview");
  const [isStudentEditOpen, setIsStudentEditOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  function syncProfileLocalState(profileData: StudentProfile) {
    setStudentForm({
      name: profileData.name,
      grade: profileData.grade ?? "",
      contact01: profileData.contact01 ?? "",
      contact02: profileData.contact02 ?? "",
      email: profileData.email ?? "",
    });

    setGuardianDrafts(
      Object.fromEntries(
        profileData.guardians.map((guardian) => [
          guardian.id,
          {
            name: guardian.name,
            relation: guardian.relation,
            phone: guardian.phone,
          },
        ])
      )
    );
  }

  const loadClasses = useCallback(async () => {
    const response = await fetch(`/api/classes?page=1&pageSize=${OPTION_PAGE_SIZE}`);
    const payload = (await response.json()) as {
      success: boolean;
      data?: ClassItem[];
      error?: ApiError;
    };

    if (!response.ok || !payload.success) {
      throw new Error(payload.error?.message ?? "Failed to load classes.");
    }

    return payload.data ?? [];
  }, []);

  const loadProfile = useCallback(async () => {
    const response = await fetch(`/api/students/${studentId}`);
    const payload = (await response.json()) as {
      success: boolean;
      data?: StudentProfile;
      error?: ApiError;
    };

    if (!response.ok || !payload.success || !payload.data) {
      throw new Error(payload.error?.message ?? "Failed to load student profile.");
    }

    return payload.data;
  }, [studentId]);

  useEffect(() => {
    async function bootstrap() {
      setIsLoading(true);
      setErrorMessage(null);

      try {
        const [classes, profileData] = await Promise.all([loadClasses(), loadProfile()]);
        setClassOptions(classes);
        setProfile(profileData);
        syncProfileLocalState(profileData);

        if (classes.length > 0) {
          setAssignClassId(classes[0].id);
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to load student profile.");
      } finally {
        setIsLoading(false);
      }
    }

    void bootstrap();
  }, [loadClasses, loadProfile]);

  async function refreshProfile() {
    const profileData = await loadProfile();
    setProfile(profileData);
    syncProfileLocalState(profileData);
  }

  async function handleUpdateStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/students/${studentId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: studentForm.name,
          grade: studentForm.grade || undefined,
          contact01: studentForm.contact01,
          contact02: studentForm.contact02,
          email: studentForm.email,
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: ApiError;
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to update student.");
        return;
      }

      setSuccessMessage("Student details updated successfully.");
      await refreshProfile();
    } catch {
      setErrorMessage("Unable to update student right now.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleAssignToClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!assignClassId) {
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch("/api/students/assign", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          classId: assignClassId,
          studentId,
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: ApiError;
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to assign student.");
        return;
      }

      setSuccessMessage("Student assigned to class successfully.");
      await refreshProfile();
    } catch {
      setErrorMessage("Unable to assign student right now.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleRemoveFromClass(classId: string, className: string) {
    const reason = removeReasonByClassId[classId]?.trim() || "";
    const confirmationText = reason
      ? `Remove this student from ${className}?\n\nReason preview:\n${reason}`
      : `Remove this student from ${className}?\n\nNo reason provided.`;

    const confirmed = window.confirm(confirmationText);

    if (!confirmed) {
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch("/api/students/remove-from-class", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          classId,
          studentId,
          reason: reason || undefined,
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: ApiError;
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to remove student from class.");
        return;
      }

      setSuccessMessage("Student removed from class successfully.");
      setRemoveReasonByClassId((prev) => ({ ...prev, [classId]: "" }));
      await refreshProfile();
    } catch {
      setErrorMessage("Unable to remove student from class right now.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleAddGuardian(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch("/api/guardians", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          studentId,
          ...guardianForm,
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: ApiError;
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to add guardian.");
        return;
      }

      setGuardianForm({ name: "", relation: "", phone: "" });
      setSuccessMessage("Guardian added successfully.");
      await refreshProfile();
    } catch {
      setErrorMessage("Unable to add guardian right now.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleUpdateGuardian(guardianId: string) {
    const draft = guardianDrafts[guardianId];

    if (!draft) {
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/guardians/${guardianId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(draft),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: ApiError;
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to update guardian.");
        return;
      }

      setSuccessMessage("Guardian details updated successfully.");
      await refreshProfile();
    } catch {
      setErrorMessage("Unable to update guardian right now.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isLoading) {
    return <p className="mt-6 text-sm text-muted">Loading student profile...</p>;
  }

  if (errorMessage && !profile) {
    return (
      <p className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>
    );
  }

  if (!profile) {
    return <p className="mt-6 text-sm text-muted">Student profile not found.</p>;
  }

  return (
    <div className="mt-6 space-y-5">
      {errorMessage ? (
        <p className="notice-error">{errorMessage}</p>
      ) : null}

      {successMessage ? (
        <p className="notice-success">
          {successMessage}
        </p>
      ) : null}

      <div className="border-b border-slate-200">
        <div className="flex items-center gap-2 overflow-x-auto pb-2">
          <button
            type="button"
            onClick={() => setActiveTab("overview")}
            className={`inline-flex items-center gap-2 rounded-t-xl border-b-2 px-3 py-2 text-xs font-semibold tracking-wide transition ${
              activeTab === "overview"
                ? "border-brand-500 text-brand-700"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            <Sparkles size={13} />
            Overview
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("classes")}
            className={`inline-flex items-center gap-2 rounded-t-xl border-b-2 px-3 py-2 text-xs font-semibold tracking-wide transition ${
              activeTab === "classes"
                ? "border-brand-500 text-brand-700"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            <BookOpen size={13} />
            Classes
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("guardians")}
            className={`inline-flex items-center gap-2 rounded-t-xl border-b-2 px-3 py-2 text-xs font-semibold tracking-wide transition ${
              activeTab === "guardians"
                ? "border-brand-500 text-brand-700"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            <Users size={13} />
            Guardians
          </button>
        </div>
      </div>

      {activeTab === "overview" ? (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.25fr_0.85fr]">
            <article className="surface-panel border border-slate-200 p-6">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-4">
                <h3 className="inline-flex items-center gap-2 text-xl font-semibold text-slate-900">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-brand-100 text-brand-700">
                    <User size={15} />
                  </span>
                  Student information
                </h3>
                <button
                  type="button"
                  onClick={() => setIsStudentEditOpen((prev) => !prev)}
                  className="btn-secondary"
                >
                  {isStudentEditOpen ? "Cancel" : "Edit"}
                </button>
              </div>

              {!isStudentEditOpen ? (
                <div className="mt-3 divide-y divide-brand-100 text-sm">
                  <div className="grid grid-cols-[170px_1fr] gap-4 py-3">
                    <p className="text-slate-500">Registration No</p>
                    <p className="font-medium text-slate-800">{profile.registrationNumber ?? "-"}</p>
                  </div>
                  <div className="grid grid-cols-[170px_1fr] gap-4 py-3">
                    <p className="text-slate-500">Full name</p>
                    <p className="font-medium text-slate-800">{profile.name}</p>
                  </div>
                  <div className="grid grid-cols-[170px_1fr] gap-4 py-3">
                    <p className="text-slate-500">Grade</p>
                    <p>
                      <span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-semibold text-violet-700">
                        {formatGradeLabel(profile.grade)}
                      </span>
                    </p>
                  </div>
                  <div className="grid grid-cols-[170px_1fr] gap-4 py-3">
                    <p className="text-slate-500">Contact 01</p>
                    <p className="inline-flex items-center gap-2 font-medium text-slate-800"><Phone size={13} />{profile.contact01 || "-"}</p>
                  </div>
                  <div className="grid grid-cols-[170px_1fr] gap-4 py-3">
                    <p className="text-slate-500">Contact 02</p>
                    <p className="inline-flex items-center gap-2 font-medium text-slate-800"><Phone size={13} />{profile.contact02 || "-"}</p>
                  </div>
                  <div className="grid grid-cols-[170px_1fr] gap-4 py-3">
                    <p className="text-slate-500">Email</p>
                    <p className="inline-flex items-center gap-2 font-medium text-slate-800"><Mail size={13} />{profile.email || "-"}</p>
                  </div>
                  <div className="grid grid-cols-[170px_1fr] gap-4 py-3">
                    <p className="text-slate-500">Status</p>
                    <p>
                      <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">Active</span>
                    </p>
                  </div>
                  <div className="grid grid-cols-[170px_1fr] gap-4 py-3">
                    <p className="text-slate-500">Joined on</p>
                    <p className="inline-flex items-center gap-2 font-medium text-slate-800"><Calendar size={13} />{formatDate(profile.createdAt)}</p>
                  </div>
                </div>
              ) : (
                <form className="mt-4 space-y-3" onSubmit={handleUpdateStudent}>
                  <input
                    required
                    value={studentForm.name}
                    onChange={(event) => setStudentForm((prev) => ({ ...prev, name: event.target.value }))}
                    className="control-input"
                    placeholder="Student name"
                  />

                  <select
                    value={studentForm.grade}
                    onChange={(event) => setStudentForm((prev) => ({ ...prev, grade: event.target.value }))}
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
                    className="btn-primary"
                  >
                    Save student details
                  </button>
                </form>
              )}
            </article>

            <article className="surface-panel border border-slate-200 p-6">
              <h3 className="inline-flex items-center gap-2 text-xl font-semibold text-slate-900">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-violet-100 text-violet-700">
                  <Sparkles size={15} />
                </span>
                Quick actions
              </h3>

              <div className="mt-4 space-y-3">
                <button type="button" onClick={() => setIsStudentEditOpen(true)} className="w-full rounded-lg border border-slate-200 bg-white p-4 text-left shadow-soft transition hover:border-brand-200 hover:bg-brand-50">
                  <p className="font-semibold text-slate-800">Edit student details</p>
                  <p className="mt-1 text-xs text-slate-500">Update personal information</p>
                </button>
                <button type="button" onClick={() => setActiveTab("classes")} className="w-full rounded-lg border border-slate-200 bg-white p-4 text-left shadow-soft transition hover:border-brand-200 hover:bg-brand-50">
                  <p className="font-semibold text-slate-800">Assign to class</p>
                  <p className="mt-1 text-xs text-slate-500">Add or change class assignment</p>
                </button>
                <button type="button" onClick={() => setActiveTab("guardians")} className="w-full rounded-lg border border-slate-200 bg-white p-4 text-left shadow-soft transition hover:border-brand-200 hover:bg-brand-50">
                  <p className="font-semibold text-slate-800">Manage guardians</p>
                  <p className="mt-1 text-xs text-slate-500">Add or update guardian details</p>
                </button>
                <button type="button" className="w-full rounded-lg border border-slate-200 bg-white p-4 text-left shadow-soft transition hover:border-brand-200 hover:bg-brand-50">
                  <p className="font-semibold text-slate-800">View activity log</p>
                  <p className="mt-1 text-xs text-slate-500">See recent activities and history</p>
                </button>
              </div>
            </article>
          </div>

          <article className="surface-panel border border-slate-200 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="inline-flex items-center gap-2 text-xl font-semibold text-slate-900">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-brand-100 text-brand-700">
                  <BookOpen size={15} />
                </span>
                Assigned classes
              </h3>
              <form className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row" onSubmit={handleAssignToClass}>
                <select
                  required
                  value={assignClassId}
                  onChange={(event) => setAssignClassId(event.target.value)}
                  className="control-select min-w-[240px]"
                >
                  <option value="">Select class</option>
                  {classOptions.map((classroom) => (
                    <option key={classroom.id} value={classroom.id}>
                      {classroom.name} ({classroom.schedule})
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="btn-primary"
                >
                  <Plus size={14} />
                  Assign to class
                </button>
              </form>
            </div>

            {profile.classes.length > 0 ? (
              <div className="mt-5 space-y-3">
                {profile.classes.map((classItem) => (
                  <div key={classItem.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-soft">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-lg font-semibold text-slate-800">{classItem.name}</p>
                        <p className="mt-1 inline-flex items-center gap-2 text-sm text-slate-600"><Clock3 size={13} />Schedule: {classItem.schedule}</p>
                        <p className="mt-1 inline-flex items-center gap-2 text-sm text-slate-600"><Calendar size={13} />Assigned: {formatDate(classItem.assignedAt)}</p>
                      </div>

                      <div className="w-full max-w-sm">
                        <textarea
                          value={removeReasonByClassId[classItem.classId] ?? ""}
                          onChange={(event) =>
                            setRemoveReasonByClassId((prev) => ({
                              ...prev,
                              [classItem.classId]: event.target.value,
                            }))
                          }
                          rows={2}
                          className="control-textarea"
                          placeholder="Reason for removing from class (optional)"
                        />
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() => void handleRemoveFromClass(classItem.classId, classItem.name)}
                          className="btn-danger mt-2"
                        >
                          Remove from class
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted">No classes assigned yet.</p>
            )}
          </article>

          <article className="surface-panel border border-slate-200 p-6">
            <div className="flex items-center justify-between gap-3">
              <h3 className="inline-flex items-center gap-2 text-xl font-semibold text-slate-900">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-violet-100 text-violet-700">
                  <Users size={15} />
                </span>
                Guardians
              </h3>
              <button type="button" className="btn-secondary" onClick={() => setActiveTab("guardians")}>
                <Plus size={14} />
                Add guardian
              </button>
            </div>

            {profile.guardians.length > 0 ? (
              <div className="mt-4 space-y-3">
                {profile.guardians.map((guardian) => {
                  const draft = guardianDrafts[guardian.id] ?? {
                    name: guardian.name,
                    relation: guardian.relation,
                    phone: guardian.phone,
                  };

                  return (
                    <div key={guardian.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-soft">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-lg font-semibold text-brand-700">
                            {guardian.name.slice(0, 1).toUpperCase()}
                          </span>
                          <div>
                            <p className="text-base font-semibold text-slate-800">{guardian.name}</p>
                            <span className="mt-1 inline-flex rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">
                              {guardian.relation || "Guardian"}
                            </span>
                            <p className="mt-2 inline-flex items-center gap-2 text-xs text-slate-600"><Phone size={12} />{guardian.phone}</p>
                            <p className="mt-1 inline-flex items-center gap-2 text-xs text-slate-600"><Mail size={12} />{guardian.email || "Not registered"}</p>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => void handleUpdateGuardian(guardian.id)}
                          disabled={isSubmitting}
                          className="btn-ghost"
                        >
                          Save
                          <ChevronRight size={14} />
                        </button>
                      </div>

                      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <input
                          value={draft.name}
                          onChange={(event) =>
                            setGuardianDrafts((prev) => ({
                              ...prev,
                              [guardian.id]: {
                                ...draft,
                                name: event.target.value,
                              },
                            }))
                          }
                          className="control-input"
                          placeholder="Guardian name"
                        />
                        <input
                          value={draft.relation}
                          onChange={(event) =>
                            setGuardianDrafts((prev) => ({
                              ...prev,
                              [guardian.id]: {
                                ...draft,
                                relation: event.target.value,
                              },
                            }))
                          }
                          className="control-input"
                          placeholder="Relation"
                        />
                        <input
                          value={draft.phone}
                          onChange={(event) =>
                            setGuardianDrafts((prev) => ({
                              ...prev,
                              [guardian.id]: {
                                ...draft,
                                phone: event.target.value,
                              },
                            }))
                          }
                          className="control-input"
                          placeholder="Phone"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted">No guardians added yet.</p>
            )}

            <form className="mt-4 rounded-lg border border-dashed border-brand-200 bg-brand-50/40 p-4" onSubmit={handleAddGuardian}>
              <p className="mb-3 text-sm font-semibold text-brand-700">Add another guardian</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <input
                  required
                  value={guardianForm.name}
                  onChange={(event) => setGuardianForm((prev) => ({ ...prev, name: event.target.value }))}
                  className="control-input"
                  placeholder="Guardian name"
                />
                <input
                  required
                  value={guardianForm.relation}
                  onChange={(event) => setGuardianForm((prev) => ({ ...prev, relation: event.target.value }))}
                  className="control-input"
                  placeholder="Relation"
                />
                <input
                  required
                  value={guardianForm.phone}
                  onChange={(event) => setGuardianForm((prev) => ({ ...prev, phone: event.target.value }))}
                  className="control-input"
                  placeholder="Phone"
                />
              </div>
              <button
                type="submit"
                disabled={isSubmitting}
                className="btn-primary mt-3"
              >
                <Plus size={14} />
                Add guardian
              </button>
            </form>
          </article>
        </div>
      ) : null}

      {activeTab === "classes" ? (
        <article
  className="
    rounded-lg
    border
    border-slate-200
    bg-white
    p-5
    shadow-sm
  "
>
          <p className="text-sm font-semibold uppercase tracking-wide text-muted">Assigned classes</p>
          {profile.classes.length > 0 ? (
            <div className="mt-3 space-y-3">
              {profile.classes.map((classItem) => (
                <div key={classItem.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-soft">
                  <p className="text-sm font-semibold">{classItem.name}</p>
                  <p className="text-xs text-muted">Schedule: {classItem.schedule}</p>
                  <p className="text-xs text-muted">Assigned: {formatDate(classItem.assignedAt)}</p>
                  <textarea
                    value={removeReasonByClassId[classItem.classId] ?? ""}
                    onChange={(event) =>
                      setRemoveReasonByClassId((prev) => ({
                        ...prev,
                        [classItem.classId]: event.target.value,
                      }))
                    }
                    rows={2}
                    className="control-textarea mt-2 text-xs"
                    placeholder="Reason for removing from class (optional)"
                  />
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => void handleRemoveFromClass(classItem.classId, classItem.name)}
                    className="btn-danger mt-2"
                  >
                    Remove from class
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">No classes assigned yet.</p>
          )}

          <form className="mt-4 flex flex-col gap-2 sm:flex-row" onSubmit={handleAssignToClass}>
            <select
              required
              value={assignClassId}
              onChange={(event) => setAssignClassId(event.target.value)}
              className="control-select"
            >
              <option value="">Select class</option>
              {classOptions.map((classroom) => (
                <option key={classroom.id} value={classroom.id}>
                  {classroom.name} ({classroom.schedule})
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={isSubmitting}
              className="btn-primary"
            >
              Assign to class
            </button>
          </form>

          <div className="mt-6">
            <p className="text-sm font-semibold uppercase tracking-wide text-muted">Assignment history</p>
            {profile.assignmentHistory.length > 0 ? (
              <div className="table-wrap mt-2">
                <table className="table-modern">
                  <thead>
                    <tr>
                      <th className="px-3 py-2">Class</th>
                      <th className="px-3 py-2">Assigned</th>
                      <th className="px-3 py-2">Removed</th>
                      <th className="px-3 py-2">Reason</th>
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profile.assignmentHistory.map((entry) => (
                      <tr key={entry.id}>
                        <td className="px-3 py-2">{entry.name}</td>
                        <td className="px-3 py-2 text-muted">{formatDate(entry.assignedAt)}</td>
                        <td className="px-3 py-2 text-muted">{formatDate(entry.removedAt)}</td>
                        <td className="px-3 py-2 text-muted">{entry.removeReason || "-"}</td>
                        <td className="px-3 py-2 text-muted">{entry.isActive ? "Active" : "Removed"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">No assignment history yet.</p>
            )}
          </div>
        </article>
      ) : null}

      {activeTab === "guardians" ? (
        <article className="surface-panel border border-slate-200 p-6">
          <p className="text-sm font-semibold uppercase tracking-wide text-muted">Guardians</p>

          {profile.guardians.length > 0 ? (
            <div className="mt-3 space-y-3">
              {profile.guardians.map((guardian) => {
                const draft = guardianDrafts[guardian.id] ?? {
                  name: guardian.name,
                  relation: guardian.relation,
                  phone: guardian.phone,
                };

                return (
                  <div key={guardian.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-soft">
                    <input
                      value={draft.name}
                      onChange={(event) =>
                        setGuardianDrafts((prev) => ({
                          ...prev,
                          [guardian.id]: {
                            ...draft,
                            name: event.target.value,
                          },
                        }))
                      }
                      className="control-input mb-2"
                    />
                    <input
                      value={draft.relation}
                      onChange={(event) =>
                        setGuardianDrafts((prev) => ({
                          ...prev,
                          [guardian.id]: {
                            ...draft,
                            relation: event.target.value,
                          },
                        }))
                      }
                      className="control-input mb-2"
                    />
                    <input
                      value={draft.phone}
                      onChange={(event) =>
                        setGuardianDrafts((prev) => ({
                          ...prev,
                          [guardian.id]: {
                            ...draft,
                            phone: event.target.value,
                          },
                        }))
                      }
                      className="control-input"
                    />
                    <p className="mt-1 text-xs text-muted">Email: {guardian.email || "Not registered"}</p>
                    <button
                      type="button"
                      onClick={() => void handleUpdateGuardian(guardian.id)}
                      disabled={isSubmitting}
                      className="btn-secondary mt-2"
                    >
                      Save guardian
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">No guardians added yet.</p>
          )}

          <form className="mt-4 space-y-2" onSubmit={handleAddGuardian}>
            <input
              required
              value={guardianForm.name}
              onChange={(event) => setGuardianForm((prev) => ({ ...prev, name: event.target.value }))}
              className="control-input"
              placeholder="Guardian name"
            />
            <input
              required
              value={guardianForm.relation}
              onChange={(event) => setGuardianForm((prev) => ({ ...prev, relation: event.target.value }))}
              className="control-input"
              placeholder="Relation"
            />
            <input
              required
              value={guardianForm.phone}
              onChange={(event) => setGuardianForm((prev) => ({ ...prev, phone: event.target.value }))}
              className="control-input"
              placeholder="Phone"
            />
            <button
              type="submit"
              disabled={isSubmitting}
              className="btn-primary"
            >
              Add guardian
            </button>
          </form>
        </article>
      ) : null}
    </div>
  );
}
