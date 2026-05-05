"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type ClassItem = {
  id: string;
  name: string;
  description: string | null;
  monthlyFee: number;
  paymentDueWeek: number;
  schedule: string;
  schedules: {
    id: string;
    dayOfWeek: "SUNDAY" | "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY";
    startTime: string;
    endTime: string;
  }[];
  students: {
    id: string;
    isActive: boolean;
    assignedAt: string;
    removedAt: string | null;
    removeReason: string | null;
    student: {
      id: string;
      name: string;
      registrationNumber: string | null;
    };
  }[];
  createdAt: string;
};

type ApiError = {
  message?: string;
};

type PaginatedResponse = {
  success: boolean;
  data?: ClassItem[];
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

type FormState = {
  name: string;
  description: string;
  monthlyFee: string;
  paymentDueWeek: string;
  schedules: {
    dayOfWeek: "SUNDAY" | "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY";
    startTime: string;
    endTime: string;
  }[];
};

type FilterState = {
  name: string;
  schedule: string;
};

const PAGE_SIZE = 4;
const CLASS_CONFIG_UPDATED_EVENT = "saastution:class-config-updated";
const WEEK_DAYS: Array<FormState["schedules"][number]["dayOfWeek"]> = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

function getDefaultScheduleRow(): FormState["schedules"][number] {
  return {
    dayOfWeek: "MONDAY",
    startTime: "09:00",
    endTime: "10:00",
  };
}

function getDayShortLabel(day: FormState["schedules"][number]["dayOfWeek"]) {
  switch (day) {
    case "SUNDAY":
      return "Sun";
    case "MONDAY":
      return "Mon";
    case "TUESDAY":
      return "Tue";
    case "WEDNESDAY":
      return "Wed";
    case "THURSDAY":
      return "Thu";
    case "FRIDAY":
      return "Fri";
    case "SATURDAY":
      return "Sat";
  }
}

export function ClassManagementPanel() {
  const [items, setItems] = useState<ClassItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>({
    name: "",
    schedule: "",
  });

  const [createForm, setCreateForm] = useState<FormState>({
    name: "",
    description: "",
    monthlyFee: "0",
    paymentDueWeek: "1",
    schedules: [getDefaultScheduleRow()],
  });
  const [isCreatePanelOpen, setIsCreatePanelOpen] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>({
    name: "",
    description: "",
    monthlyFee: "0",
    paymentDueWeek: "1",
    schedules: [getDefaultScheduleRow()],
  });
  const [activeTabs, setActiveTabs] = useState<Record<string, "details" | "schedule" | "students">>({});  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const hasData = useMemo(() => items.length > 0, [items]);

  const loadClasses = useCallback(async (nextPage = 1, appliedFilters: FilterState) => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const query = new URLSearchParams({
        page: String(nextPage),
        pageSize: String(PAGE_SIZE),
      });

      if (appliedFilters.name.trim()) {
        query.set("name", appliedFilters.name.trim());
      }

      if (appliedFilters.schedule.trim()) {
        query.set("schedule", appliedFilters.schedule.trim());
      }

      const response = await fetch(`/api/classes?${query.toString()}`);
      const payload = (await response.json()) as PaginatedResponse;

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to load classes.");
        return;
      }

      setItems(payload.data ?? []);
      setPage(payload.pagination?.page ?? nextPage);
      setTotalPages(payload.pagination?.totalPages ?? 1);
    } catch {
      setErrorMessage("Unable to load classes right now.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadClasses(1, { name: "", schedule: "" });
  }, [loadClasses]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch("/api/classes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...createForm,
          monthlyFee: Number(createForm.monthlyFee || 0),
          paymentDueWeek: Number(createForm.paymentDueWeek || 1),
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: ApiError;
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to create class.");
        return;
      }

      setCreateForm({
        name: "",
        description: "",
        monthlyFee: "0",
        paymentDueWeek: "1",
        schedules: [getDefaultScheduleRow()],
      });
      setIsCreatePanelOpen(false);
      setSuccessMessage("Class created successfully.");
      await loadClasses(1, filters);
      window.dispatchEvent(new CustomEvent(CLASS_CONFIG_UPDATED_EVENT));
    } catch {
      setErrorMessage("Unable to create class right now.");
    } finally {
      setIsSaving(false);
    }
  }

  function beginEdit(item: ClassItem) {
    setEditingId(item.id);
    setEditForm({
      name: item.name,
      description: item.description ?? "",
      monthlyFee: String(item.monthlyFee),
      paymentDueWeek: String(item.paymentDueWeek),
      schedules:
        item.schedules.length > 0
          ? item.schedules.map((schedule) => ({
              dayOfWeek: schedule.dayOfWeek,
              startTime: schedule.startTime,
              endTime: schedule.endTime,
            }))
          : [getDefaultScheduleRow()],
    });
    setErrorMessage(null);
    setSuccessMessage(null);
  }

  async function saveEdit(classId: string) {
    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/classes/${classId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...editForm,
          monthlyFee: Number(editForm.monthlyFee || 0),
          paymentDueWeek: Number(editForm.paymentDueWeek || 1),
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: ApiError;
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to update class.");
        return;
      }

      setEditingId(null);
      setSuccessMessage("Class updated successfully.");
      window.dispatchEvent(new CustomEvent(CLASS_CONFIG_UPDATED_EVENT));
      await loadClasses(page, filters);
    } catch {
      setErrorMessage("Unable to update class right now.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteClass(classId: string) {
    const confirmed = window.confirm("Are you sure you want to delete this class?");

    if (!confirmed) {
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/classes/${classId}`, {
        method: "DELETE",
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: ApiError;
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to delete class.");
        return;
      }

      setSuccessMessage("Class deleted successfully.");
      window.dispatchEvent(new CustomEvent(CLASS_CONFIG_UPDATED_EVENT));
      const nextPage = items.length === 1 && page > 1 ? page - 1 : page;
      await loadClasses(nextPage, filters);
    } catch {
      setErrorMessage("Unable to delete class right now.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="relative">
      <article className="panel-shell">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Your classes</h2>
            <p className="text-sm text-muted">
              Page {page} of {totalPages}
            </p>
          </div>
          <div className="flex gap-2 sm:mt-0">
            <button
              type="button"
              onClick={() => setIsCreatePanelOpen(true)}
              className="btn-primary mt-3 sm:mt-0"
            >
              Add class
            </button>
            <button
              type="button"
              onClick={() => setIsHelpOpen(true)}
              className="btn-ghost mt-3 sm:mt-0"
            >
              Help
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            value={filters.name}
            onChange={(event) => setFilters((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="Filter by class name"
            className="control-input"
          />
          <input
            value={filters.schedule}
            onChange={(event) => setFilters((prev) => ({ ...prev, schedule: event.target.value }))}
            placeholder="Filter by schedule"
            className="control-input"
          />
        </div>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            disabled={isLoading}
            onClick={() => void loadClasses(1, filters)}
            className="btn-primary"
          >
            Apply filters
          </button>
          <button
            type="button"
            disabled={isLoading}
            onClick={() => {
              const cleared = { name: "", schedule: "" };
              setFilters(cleared);
              void loadClasses(1, cleared);
            }}
            className="btn-ghost"
          >
            Clear filters
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

        {isLoading ? <p className="mt-5 text-sm text-muted">Loading classes...</p> : null}

        {!isLoading && !hasData ? (
          <p className="mt-5 text-sm text-muted">No classes found. Try updating your filters or create a new class.</p>
        ) : null}

        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          {items.map((item) => {
            const isEditing = editingId === item.id;
            const activeTab = activeTabs[item.id] ?? "details";
            const activeStudents = item.students.filter((entry) => entry.isActive);
            const pastStudents = item.students.filter((entry) => !entry.isActive);

            return (
              <div
                key={item.id}
                className="surface-card p-4"
              >
                {isEditing ? (
                  <div className="space-y-3">
                    <input
                      value={editForm.name}
                      onChange={(event) => setEditForm((prev) => ({ ...prev, name: event.target.value }))}
                      className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
                    />
                    <input
                      type="number"
                      min="0"
                      value={editForm.monthlyFee}
                      onChange={(event) => setEditForm((prev) => ({ ...prev, monthlyFee: event.target.value }))}
                      className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
                      placeholder="Monthly fee"
                    />
                    <select
                      value={editForm.paymentDueWeek}
                      onChange={(event) => setEditForm((prev) => ({ ...prev, paymentDueWeek: event.target.value }))}
                      className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
                    >
                      <option value="1">Payment due in 1st week</option>
                      <option value="2">Payment due in 2nd week</option>
                      <option value="3">Payment due in 3rd week</option>
                      <option value="4">Payment due in 4th week</option>
                    </select>
                    <input
                      value={editForm.schedules
                        .map((row) => `${getDayShortLabel(row.dayOfWeek)} ${row.startTime}-${row.endTime}`)
                        .join(" | ")}
                      readOnly
                      className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
                    />
                    <div className="space-y-3">
                      {editForm.schedules.map((schedule, index) => (
                        <div key={`${schedule.dayOfWeek}-${index}`} className="rounded-xl border border-black/10 p-3 dark:border-white/10">
                          <div>
                            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
                              Day of week
                            </label>
                            <select
                              value={schedule.dayOfWeek}
                              onChange={(event) => {
                                const day = event.target.value as FormState["schedules"][number]["dayOfWeek"];
                                setEditForm((prev) => ({
                                  ...prev,
                                  schedules: prev.schedules.map((item, itemIndex) =>
                                    itemIndex === index ? { ...item, dayOfWeek: day } : item
                                  ),
                                }));
                              }}
                              className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
                            >
                              {WEEK_DAYS.map((day) => (
                                <option key={day} value={day}>
                                  {day}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                            <div>
                              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
                                Start time
                              </label>
                              <input
                                type="time"
                                value={schedule.startTime}
                                onChange={(event) => {
                                  const value = event.target.value;
                                  setEditForm((prev) => ({
                                    ...prev,
                                    schedules: prev.schedules.map((item, itemIndex) =>
                                      itemIndex === index ? { ...item, startTime: value } : item
                                    ),
                                  }));
                                }}
                                className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
                              />
                            </div>

                            <div>
                              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
                                End time
                              </label>
                              <input
                                type="time"
                                value={schedule.endTime}
                                onChange={(event) => {
                                  const value = event.target.value;
                                  setEditForm((prev) => ({
                                    ...prev,
                                    schedules: prev.schedules.map((item, itemIndex) =>
                                      itemIndex === index ? { ...item, endTime: value } : item
                                    ),
                                  }));
                                }}
                                className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
                              />
                            </div>

                            <button
                              type="button"
                              disabled={editForm.schedules.length <= 1}
                              onClick={() => {
                                setEditForm((prev) => ({
                                  ...prev,
                                  schedules: prev.schedules.filter((_, itemIndex) => itemIndex !== index),
                                }));
                              }}
                              className="self-end rounded-lg border border-red-300 px-3 py-2 text-xs font-semibold text-red-700 disabled:opacity-50"
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => {
                          setEditForm((prev) => ({
                            ...prev,
                            schedules: [...prev.schedules, getDefaultScheduleRow()],
                          }));
                        }}
                        className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold dark:border-white/20"
                      >
                        Add schedule row
                      </button>
                    </div>
                    <textarea
                      rows={3}
                      value={editForm.description}
                      onChange={(event) => setEditForm((prev) => ({ ...prev, description: event.target.value }))}
                      className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={isSaving}
                        onClick={() => void saveEdit(item.id)}
                        className="flex-1 rounded-lg bg-foreground px-3 py-2 text-sm font-semibold text-background"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        disabled={isSaving}
                        onClick={() => setEditingId(null)}
                        className="flex-1 rounded-lg border border-black/15 px-3 py-2 text-sm font-semibold dark:border-white/20"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-base font-semibold">{item.name}</h3>
                      <p className="text-xs text-muted">
                        Created {new Date(item.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <p className="mt-2 text-sm font-medium text-brand-700">Monthly fee: Rs {item.monthlyFee.toLocaleString()}</p>
                    <p className="mt-1 text-xs text-muted">Payment submission week: Week {item.paymentDueWeek}</p>

                    <div className="mt-3 border-b border-black/15 dark:border-white/15">
                      <div className="tab-strip">
                        <button
                          type="button"
                          onClick={() => setActiveTabs((prev) => ({ ...prev, [item.id]: "details" }))}
                          className={`tab-btn ${
                            activeTab === "details"
                              ? "tab-btn-active"
                              : "tab-btn-inactive"
                          }`}
                        >
                          Details
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveTabs((prev) => ({ ...prev, [item.id]: "schedule" }))}
                          className={`tab-btn ${
                            activeTab === "schedule"
                              ? "tab-btn-active"
                              : "tab-btn-inactive"
                          }`}
                        >
                          Schedule
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveTabs((prev) => ({ ...prev, [item.id]: "students" }))}
                          className={`tab-btn ${
                            activeTab === "students"
                              ? "tab-btn-active"
                              : "tab-btn-inactive"
                          }`}
                        >
                          Students
                        </button>
                      </div>
                    </div>

                    {activeTab === "details" ? (
                      <div className="mt-3 space-y-2">
                        <p className="surface-soft px-3 py-2 text-sm text-muted">
                          {item.description || "No description provided."}
                        </p>
                        <p className="text-xs font-medium text-muted">Summary: {item.schedule}</p>
                      </div>
                    ) : activeTab === "schedule" ? (
                      <div className="mt-3">
                        {item.schedules.length > 0 ? (
                          <div className="space-y-2">
                            {item.schedules.map((schedule) => (
                              <div
                                key={schedule.id}
                                className="surface-soft grid grid-cols-[90px_1fr] items-center px-3 py-2 text-sm"
                              >
                                <span className="font-semibold text-foreground">{getDayShortLabel(schedule.dayOfWeek)}</span>
                                <span className="text-muted">
                                  {schedule.startTime} - {schedule.endTime}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-muted">No schedules configured for this class.</p>
                        )}
                      </div>
                    ) : (
                      <div className="mt-3 grid gap-3">
                        <div className="surface-soft p-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Active students ({activeStudents.length})</p>
                          {activeStudents.length === 0 ? (
                            <p className="mt-2 text-sm text-muted">No active students currently assigned.</p>
                          ) : (
                            <div className="mt-2 space-y-2">
                              {activeStudents.map((entry) => (
                                <div key={entry.id} className="rounded-lg border border-brand-200 bg-white px-3 py-2">
                                  <p className="text-sm font-semibold text-foreground">
                                    {entry.student.name}
                                    {entry.student.registrationNumber ? (
                                      <span className="ml-1 text-xs font-normal text-muted">({entry.student.registrationNumber})</span>
                                    ) : null}
                                  </p>
                                  <p className="text-xs text-muted">Joined: {new Date(entry.assignedAt).toLocaleString()}</p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="surface-soft p-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Past students ({pastStudents.length})</p>
                          {pastStudents.length === 0 ? (
                            <p className="mt-2 text-sm text-muted">No past student records yet.</p>
                          ) : (
                            <div className="mt-2 space-y-2">
                              {pastStudents.map((entry) => (
                                <div key={entry.id} className="rounded-lg border border-brand-200 bg-white px-3 py-2">
                                  <p className="text-sm font-semibold text-foreground">
                                    {entry.student.name}
                                    {entry.student.registrationNumber ? (
                                      <span className="ml-1 text-xs font-normal text-muted">({entry.student.registrationNumber})</span>
                                    ) : null}
                                  </p>
                                  <p className="text-xs text-muted">Joined: {new Date(entry.assignedAt).toLocaleString()}</p>
                                  <p className="text-xs text-muted">Removed: {entry.removedAt ? new Date(entry.removedAt).toLocaleString() : "-"}</p>
                                  {entry.removeReason ? <p className="text-xs text-muted">Reason: {entry.removeReason}</p> : null}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="mt-4 flex gap-2">
                      <button
                        type="button"
                        onClick={() => beginEdit(item)}
                        className="btn-ghost flex-1"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={isSaving}
                        onClick={() => void deleteClass(item.id)}
                        className="flex-1 rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-700"
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex items-center justify-between">
          <button
            type="button"
            disabled={page <= 1 || isLoading}
            onClick={() => void loadClasses(page - 1, filters)}
            className="btn-ghost"
          >
            Previous
          </button>

          <button
            type="button"
            disabled={page >= totalPages || isLoading}
            onClick={() => void loadClasses(page + 1, filters)}
            className="btn-ghost"
          >
            Next
          </button>
        </div>
      </article>

      <button
        type="button"
        aria-label="Close add class panel"
        onClick={() => setIsCreatePanelOpen(false)}
        className={`fixed inset-0 z-40 bg-black/40 transition ${isCreatePanelOpen ? "visible opacity-100" : "invisible opacity-0"}`}
      />

      <aside
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-xl overflow-y-auto border-l border-black/10 bg-card p-5 shadow-2xl transition-transform duration-300 dark:border-white/10 sm:p-6 ${
          isCreatePanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Add class</h3>
            <p className="mt-1 text-sm text-muted">Add class details and schedules for your students.</p>
          </div>
          <button
            type="button"
            onClick={() => setIsCreatePanelOpen(false)}
            className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold dark:border-white/20"
          >
            Close
          </button>
        </div>

        <form className="mt-4 space-y-4" onSubmit={handleCreate}>
          <div>
            <label htmlFor="className" className="mb-1 block text-sm font-medium">
              Class name
            </label>
            <input
              id="className"
              required
              value={createForm.name}
              onChange={(event) => setCreateForm((prev) => ({ ...prev, name: event.target.value }))}
              className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
              placeholder="Math - Grade 7"
            />
          </div>

          <div>
            <label htmlFor="classMonthlyFee" className="mb-1 block text-sm font-medium">
              Monthly fee (LKR)
            </label>
            <input
              id="classMonthlyFee"
              type="number"
              min="0"
              required
              value={createForm.monthlyFee}
              onChange={(event) => setCreateForm((prev) => ({ ...prev, monthlyFee: event.target.value }))}
              className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
              placeholder="2500"
            />
          </div>

          <div>
            <label htmlFor="classPaymentDueWeek" className="mb-1 block text-sm font-medium">
              Payment due week
            </label>
            <select
              id="classPaymentDueWeek"
              required
              value={createForm.paymentDueWeek}
              onChange={(event) => setCreateForm((prev) => ({ ...prev, paymentDueWeek: event.target.value }))}
              className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
            >
              <option value="1">First week</option>
              <option value="2">Second week</option>
              <option value="3">Third week</option>
              <option value="4">Fourth week</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Class schedules</label>
            <div className="space-y-3">
              {createForm.schedules.map((schedule, index) => (
                <div key={`${schedule.dayOfWeek}-${index}`} className="rounded-xl border border-black/10 p-3 dark:border-white/10">
                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
                      Day of week
                    </label>
                    <select
                      value={schedule.dayOfWeek}
                      onChange={(event) => {
                        const day = event.target.value as FormState["schedules"][number]["dayOfWeek"];
                        setCreateForm((prev) => ({
                          ...prev,
                          schedules: prev.schedules.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, dayOfWeek: day } : item
                          ),
                        }));
                      }}
                      className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
                    >
                      {WEEK_DAYS.map((day) => (
                        <option key={day} value={day}>
                          {day}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <div>
                      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
                        Start time
                      </label>
                      <input
                        type="time"
                        value={schedule.startTime}
                        onChange={(event) => {
                          const value = event.target.value;
                          setCreateForm((prev) => ({
                            ...prev,
                            schedules: prev.schedules.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, startTime: value } : item
                            ),
                          }));
                        }}
                        className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
                        End time
                      </label>
                      <input
                        type="time"
                        value={schedule.endTime}
                        onChange={(event) => {
                          const value = event.target.value;
                          setCreateForm((prev) => ({
                            ...prev,
                            schedules: prev.schedules.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, endTime: value } : item
                            ),
                          }));
                        }}
                        className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
                      />
                    </div>

                    <button
                      type="button"
                      disabled={createForm.schedules.length <= 1}
                      onClick={() => {
                        setCreateForm((prev) => ({
                          ...prev,
                          schedules: prev.schedules.filter((_, itemIndex) => itemIndex !== index),
                        }));
                      }}
                      className="self-end rounded-xl border border-red-300 px-3 py-2.5 text-xs font-semibold text-red-700 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setCreateForm((prev) => ({
                  ...prev,
                  schedules: [...prev.schedules, getDefaultScheduleRow()],
                }));
              }}
              className="mt-2 rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold dark:border-white/20"
            >
              Add schedule row
            </button>
          </div>

          <div>
            <label htmlFor="classScheduleSummary" className="mb-1 block text-sm font-medium">
              Schedule summary (optional)
            </label>
            <input
              id="classScheduleSummary"
              value={createForm.schedules
                .map((row) => `${getDayShortLabel(row.dayOfWeek)} ${row.startTime}-${row.endTime}`)
                .join(" | ")}
              readOnly
              className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
              placeholder="Auto-generated from schedule rows"
            />
          </div>

          <div>
            <label htmlFor="classDescription" className="mb-1 block text-sm font-medium">
              Description
            </label>
            <textarea
              id="classDescription"
              rows={4}
              value={createForm.description}
              onChange={(event) => setCreateForm((prev) => ({ ...prev, description: event.target.value }))}
              className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
              placeholder="Weekly class focus and outcomes"
            />
          </div>

          <button
            type="submit"
            disabled={isSaving}
            className="w-full rounded-xl bg-foreground px-4 py-2.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? "Saving..." : "Create class"}
          </button>
        </form>
      </aside>

      {isHelpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-black/10 bg-card p-4 shadow-2xl dark:border-white/10">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Class Management</h2>
              <button
                onClick={() => setIsHelpOpen(false)}
                className="inline-flex rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
              >
                Close
              </button>
            </div>
            <div className="space-y-4 text-sm">
              <div>
                <h3 className="font-semibold">Create Classes</h3>
                <p className="mt-1 text-muted">Add new teaching classes with names, descriptions, and weekly schedules. Define which days and times each class meets.</p>
              </div>
              <div>
                <h3 className="font-semibold">Edit Class Details</h3>
                <p className="mt-1 text-muted">Update class information and schedules after creation. Click the edit button on any class card to modify its details.</p>
              </div>
              <div>
                <h3 className="font-semibold">Filter & Search</h3>
                <p className="mt-1 text-muted">Use name and schedule filters to find specific classes. Apply filters to narrow results or clear to see all classes.</p>
              </div>
              <div>
                <h3 className="font-semibold">Manage Schedules</h3>
                <p className="mt-1 text-muted">Add multiple schedule rows per class to define complex weekly patterns. Each row specifies a day and start/end time.</p>
              </div>
              <div className="border-t border-black/10 pt-4 dark:border-white/10">
                <h3 className="font-semibold">How to Use</h3>
                <ol className="mt-2 list-inside list-decimal space-y-1 text-muted">
                  <li>Click "Add class" to open the creation form</li>
                  <li>Enter a class name and optional description</li>
                  <li>Add schedule rows with days and times</li>
                  <li>Submit to create the class</li>
                  <li>Use filters to find and manage your classes</li>
                </ol>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
