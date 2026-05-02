"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";

type ClassItem = {
  id: string;
  name: string;
  schedule: string;
};

type StudentProfile = {
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
      <p className="mt-6 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>
    );
  }

  if (!profile) {
    return <p className="mt-6 text-sm text-muted">Student profile not found.</p>;
  }

  return (
    <div className="mt-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{profile.name}</h2>
          <p className="text-sm text-muted">Professional student profile</p>
        </div>
        <Link
          href="/dashboard/students"
          className="inline-flex rounded-xl border border-black/15 px-4 py-2 text-sm font-medium dark:border-white/20"
        >
          Back to students
        </Link>
      </div>

      {errorMessage ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>
      ) : null}

      {successMessage ? (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {successMessage}
        </p>
      ) : null}

      <div className="border-b border-black/15 dark:border-white/15">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setActiveTab("overview")}
            className={`-mb-px border-b-2 px-1 py-2 text-xs font-semibold tracking-wide transition ${
              activeTab === "overview"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            Overview
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("classes")}
            className={`-mb-px border-b-2 px-1 py-2 text-xs font-semibold tracking-wide transition ${
              activeTab === "classes"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            Classes
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("guardians")}
            className={`-mb-px border-b-2 px-1 py-2 text-xs font-semibold tracking-wide transition ${
              activeTab === "guardians"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            Guardians
          </button>
        </div>
      </div>

      {activeTab === "overview" ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.2fr_1fr]">
          <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold uppercase tracking-wide text-muted">Student details</p>
              <span className="rounded-full border border-black/15 px-2 py-0.5 text-xs font-semibold dark:border-white/20">
                {profile.registrationNumber ?? "No reg no"}
              </span>
            </div>

            <form className="mt-4 space-y-3" onSubmit={handleUpdateStudent}>
              <input
                required
                value={studentForm.name}
                onChange={(event) => setStudentForm((prev) => ({ ...prev, name: event.target.value }))}
                className="w-full rounded-xl border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
                placeholder="Student name"
              />

              <select
                value={studentForm.grade}
                onChange={(event) => setStudentForm((prev) => ({ ...prev, grade: event.target.value }))}
                className="w-full rounded-xl border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
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
                className="w-full rounded-xl border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
                placeholder="Contact 01"
              />

              <input
                required
                value={studentForm.contact02}
                onChange={(event) => setStudentForm((prev) => ({ ...prev, contact02: event.target.value }))}
                className="w-full rounded-xl border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
                placeholder="Contact 02"
              />

              <input
                type="email"
                required
                value={studentForm.email}
                onChange={(event) => setStudentForm((prev) => ({ ...prev, email: event.target.value }))}
                className="w-full rounded-xl border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
                placeholder="Email"
              />

              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-xl bg-foreground px-4 py-2 text-sm font-semibold text-background"
              >
                Save student details
              </button>
            </form>
          </article>

          <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
            <p className="text-sm font-semibold uppercase tracking-wide text-muted">Guardians quick edit</p>
            {profile.guardians.length > 0 ? (
              <div className="mt-3 space-y-3">
                {profile.guardians.map((guardian) => {
                  const draft = guardianDrafts[guardian.id] ?? {
                    name: guardian.name,
                    relation: guardian.relation,
                    phone: guardian.phone,
                  };

                  return (
                    <div key={guardian.id} className="rounded-xl border border-black/10 p-3 dark:border-white/10">
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
                        className="mb-2 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
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
                        className="mb-2 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
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
                        className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
                      />
                      <button
                        type="button"
                        onClick={() => void handleUpdateGuardian(guardian.id)}
                        disabled={isSubmitting}
                        className="mt-2 rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold dark:border-white/20"
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
          </article>
        </div>
      ) : null}

      {activeTab === "classes" ? (
        <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
          <p className="text-sm font-semibold uppercase tracking-wide text-muted">Assigned classes</p>
          {profile.classes.length > 0 ? (
            <div className="mt-3 space-y-3">
              {profile.classes.map((classItem) => (
                <div key={classItem.id} className="rounded-xl border border-black/10 p-3 dark:border-white/10">
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
                    className="mt-2 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-xs outline-none dark:border-white/20 dark:bg-transparent"
                    placeholder="Reason for removing from class (optional)"
                  />
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => void handleRemoveFromClass(classItem.classId, classItem.name)}
                    className="mt-2 rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700"
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
              className="w-full rounded-xl border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
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
              className="rounded-xl border border-black/15 px-4 py-2 text-sm font-semibold dark:border-white/20"
            >
              Assign to class
            </button>
          </form>

          <div className="mt-6">
            <p className="text-sm font-semibold uppercase tracking-wide text-muted">Assignment history</p>
            {profile.assignmentHistory.length > 0 ? (
              <div className="mt-2 overflow-x-auto rounded-2xl border border-black/10 dark:border-white/10">
                <table className="min-w-full divide-y divide-black/10 text-left text-sm dark:divide-white/10">
                  <thead className="bg-black/[0.03] text-xs font-semibold uppercase tracking-wide text-muted dark:bg-white/[0.04]">
                    <tr>
                      <th className="px-3 py-2">Class</th>
                      <th className="px-3 py-2">Assigned</th>
                      <th className="px-3 py-2">Removed</th>
                      <th className="px-3 py-2">Reason</th>
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-black/10 dark:divide-white/10">
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
        <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
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
                  <div key={guardian.id} className="rounded-xl border border-black/10 p-3 dark:border-white/10">
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
                      className="mb-2 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
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
                      className="mb-2 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
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
                      className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none dark:border-white/20 dark:bg-transparent"
                    />
                    <p className="mt-1 text-xs text-muted">Email: {guardian.email || "Not registered"}</p>
                    <button
                      type="button"
                      onClick={() => void handleUpdateGuardian(guardian.id)}
                      disabled={isSubmitting}
                      className="mt-2 rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold dark:border-white/20"
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
              className="w-full rounded-xl border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
              placeholder="Guardian name"
            />
            <input
              required
              value={guardianForm.relation}
              onChange={(event) => setGuardianForm((prev) => ({ ...prev, relation: event.target.value }))}
              className="w-full rounded-xl border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
              placeholder="Relation"
            />
            <input
              required
              value={guardianForm.phone}
              onChange={(event) => setGuardianForm((prev) => ({ ...prev, phone: event.target.value }))}
              className="w-full rounded-xl border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
              placeholder="Phone"
            />
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-xl bg-foreground px-4 py-2 text-sm font-semibold text-background"
            >
              Add guardian
            </button>
          </form>
        </article>
      ) : null}
    </div>
  );
}
