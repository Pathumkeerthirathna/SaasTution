"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Atom,
  ArrowUpRight,
  BookOpen,
  Calculator,
  CalendarDays,
  CircleHelp,
  Clock3,
  Eraser,
  FileText,
  Filter,
  FlaskConical,
  Globe2,
  GraduationCap,
  Languages,
  Layers3,
  Music2,
  Pencil,
  Search,
  Sparkles,
  TrendingUp,
  Trash2,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

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

function getClassIcon(name: string): { Icon: LucideIcon; iconWrapClass: string } {
  const normalized = name.toLowerCase();

  if (/(math|algebra|geometry|calculus|arith)/.test(normalized)) {
    return { Icon: Calculator, iconWrapClass: "bg-blue-100 text-blue-700" };
  }
  if (/(science|chem|biology|bio|lab)/.test(normalized)) {
    return { Icon: FlaskConical, iconWrapClass: "bg-emerald-100 text-emerald-700" };
  }
  if (/(physics|astronomy|space)/.test(normalized)) {
    return { Icon: Atom, iconWrapClass: "bg-cyan-100 text-cyan-700" };
  }
  if (/(english|sinhala|tamil|language|literature|grammar)/.test(normalized)) {
    return { Icon: Languages, iconWrapClass: "bg-violet-100 text-violet-700" };
  }
  if (/(history|civics|geography|social)/.test(normalized)) {
    return { Icon: Globe2, iconWrapClass: "bg-amber-100 text-amber-700" };
  }
  if (/(music|drama|dance)/.test(normalized)) {
    return { Icon: Music2, iconWrapClass: "bg-pink-100 text-pink-700" };
  }
  if (/(art|drawing|paint|design)/.test(normalized)) {
    return { Icon: Eraser, iconWrapClass: "bg-rose-100 text-rose-700" };
  }

  return { Icon: BookOpen, iconWrapClass: "bg-brand-100 text-brand-700" };
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
  const [activeTabs, setActiveTabs] = useState<Record<string, "details" | "schedule" | "students">>({});
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [studentsPanelClassId, setStudentsPanelClassId] = useState<string | null>(null);
  const hasData = useMemo(() => items.length > 0, [items]);
  const studentsPanelClass = useMemo(
    () => items.find((item) => item.id === studentsPanelClassId) ?? null,
    [items, studentsPanelClassId]
  );
  const studentsPanelActiveStudents = useMemo(
    () => studentsPanelClass?.students.filter((entry) => entry.isActive) ?? [],
    [studentsPanelClass]
  );
  const studentsPanelPastStudents = useMemo(
    () => studentsPanelClass?.students.filter((entry) => !entry.isActive) ?? [],
    [studentsPanelClass]
  );
  const overview = useMemo(() => {
    const totalClasses = items.length;
    const activeStudents = items.reduce(
      (count, item) => count + item.students.filter((entry) => entry.isActive).length,
      0
    );
    const scheduleSlots = items.reduce((count, item) => count + item.schedules.length, 0);
    const averageFee =
      totalClasses > 0
        ? Math.round(items.reduce((sum, item) => sum + item.monthlyFee, 0) / totalClasses)
        : 0;

    return {
      totalClasses,
      activeStudents,
      scheduleSlots,
      averageFee,
    };
  }, [items]);

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

  useEffect(() => {
    if (!studentsPanelClassId) return;
    if (!items.some((item) => item.id === studentsPanelClassId)) {
      setStudentsPanelClassId(null);
    }
  }, [items, studentsPanelClassId]);

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
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute -left-28 -top-28 h-80 w-80 rounded-full bg-brand-100 blur-3xl" />
      <div className="pointer-events-none absolute -right-24 top-20 h-72 w-72 rounded-full bg-cyan-100 blur-3xl" />

      <article className="panel-shell relative space-y-6">
        <div className="hero-shell">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-100 text-brand-700">
                <GraduationCap size={20} />
              </span>
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">Your classes</h2>
                <p className="mt-1 text-sm text-muted">Manage your classes, schedules and students in one place.</p>
                <p className="mt-5">
                  <span className="metric-badge"><Sparkles size={12} />Page {page} of {totalPages}</span>
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setIsHelpOpen(true)}
                className="btn-secondary gap-2"
              >
                <CircleHelp size={14} />
                Help
              </button>
              <button
                type="button"
                onClick={() => setIsCreatePanelOpen(true)}
                className="btn-primary gap-2"
              >
                <span aria-hidden="true">+</span>
                Add class
              </button>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="metric-tile">
              <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand-100 text-brand-700">
                <Layers3 size={16} />
              </div>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Total classes</p>
              <p className="mt-2 text-3xl font-semibold tracking-tight text-foreground">{overview.totalClasses}</p>
              <p className="mt-1 inline-flex items-center gap-1 text-xs text-brand-700"><ArrowUpRight size={12} />Current page records</p>
            </div>
            <div className="metric-tile">
              <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                <Users size={16} />
              </div>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Active students</p>
              <p className="mt-2 text-3xl font-semibold tracking-tight text-foreground">{overview.activeStudents}</p>
              <p className="mt-1 inline-flex items-center gap-1 text-xs text-emerald-700"><TrendingUp size={12} />Across visible classes</p>
            </div>
            <div className="metric-tile">
              <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-100 text-cyan-700">
                <CalendarDays size={16} />
              </div>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Schedule slots</p>
              <p className="mt-2 text-3xl font-semibold tracking-tight text-foreground">{overview.scheduleSlots}</p>
              <p className="mt-1 inline-flex items-center gap-1 text-xs text-cyan-700"><Activity size={12} />Weekly timetable rows</p>
            </div>
            <div className="metric-tile">
              <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
                <BookOpen size={16} />
              </div>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Average fee</p>
              <p className="mt-2 text-3xl font-semibold tracking-tight text-foreground">Rs {overview.averageFee.toLocaleString()}</p>
              <p className="mt-1 inline-flex items-center gap-1 text-xs text-amber-700"><ArrowUpRight size={12} />Per class (visible)</p>
            </div>
          </div>
        </div>

        <div className="filter-shell mt-7">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={filters.name}
                onChange={(event) => setFilters((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="Filter by class name"
                className="control-input pl-9"
              />
            </div>
            <div className="relative">
              <CalendarDays size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={filters.schedule}
                onChange={(event) => setFilters((prev) => ({ ...prev, schedule: event.target.value }))}
                placeholder="Filter by schedule"
                className="control-input pl-9"
              />
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              disabled={isLoading}
              onClick={() => void loadClasses(1, filters)}
              className="btn-primary gap-2"
            >
              <Filter size={14} />
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
              className="btn-ghost gap-2"
            >
              <X size={14} />
              Clear filters
            </button>
          </div>
        </div>

        {errorMessage ? (
          <p className="notice-error mt-6">{errorMessage}</p>
        ) : null}

        {successMessage ? (
          <p className="notice-success mt-6">
            {successMessage}
          </p>
        ) : null}

        {isLoading ? <p className="mt-6 text-sm text-muted">Loading classes...</p> : null}

        {!isLoading && !hasData ? (
          <div className="empty-state mt-6">
            <span className="empty-state__icon"><GraduationCap size={18} /></span>
            <p className="text-sm font-semibold text-foreground">No classes found</p>
            <p className="text-sm text-muted">Try updating your filters or create a new class.</p>
            <button type="button" onClick={() => setIsCreatePanelOpen(true)} className="btn-primary">Add class</button>
          </div>
        ) : null}

        <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
          {items.map((item) => {
            const isEditing = editingId === item.id;
            const activeTab = activeTabs[item.id] ?? "details";
            const activeStudents = item.students.filter((entry) => entry.isActive);
            const pastStudents = item.students.filter((entry) => !entry.isActive);
            const classIcon = getClassIcon(item.name);
            const ClassIcon = classIcon.Icon;

            return (
              <div
                key={item.id}
                className="surface-card group rounded-3xl bg-gradient-to-br from-white to-brand-50 p-7 hover:-translate-y-1 hover:shadow-panel transition-all duration-300"
              >
                {isEditing ? (
                  <div className="space-y-4">
                    <div className="form-section">
                      <label className="form-label">Class name</label>
                      <input
                        value={editForm.name}
                        onChange={(event) => setEditForm((prev) => ({ ...prev, name: event.target.value }))}
                        className="control-input"
                      />
                    </div>

                    <div className="form-section grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label className="form-label">Monthly fee</label>
                        <input
                          type="number"
                          min="0"
                          value={editForm.monthlyFee}
                          onChange={(event) => setEditForm((prev) => ({ ...prev, monthlyFee: event.target.value }))}
                          className="control-input"
                          placeholder="Monthly fee"
                        />
                      </div>
                      <div>
                        <label className="form-label">Payment due week</label>
                        <select
                          value={editForm.paymentDueWeek}
                          onChange={(event) => setEditForm((prev) => ({ ...prev, paymentDueWeek: event.target.value }))}
                          className="control-select"
                        >
                          <option value="1">Payment due in 1st week</option>
                          <option value="2">Payment due in 2nd week</option>
                          <option value="3">Payment due in 3rd week</option>
                          <option value="4">Payment due in 4th week</option>
                        </select>
                      </div>
                    </div>

                    <div className="form-section">
                      <label className="form-label">Schedule summary</label>
                      <input
                        value={editForm.schedules
                          .map((row) => `${getDayShortLabel(row.dayOfWeek)} ${row.startTime}-${row.endTime}`)
                          .join(" | ")}
                        readOnly
                        className="control-input"
                      />
                    </div>

                    <div className="space-y-3">
                      {editForm.schedules.map((schedule, index) => (
                        <div key={`${schedule.dayOfWeek}-${index}`} className="schedule-card">
                          <div>
                            <label className="form-label">
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
                              className="control-select"
                            >
                              {WEEK_DAYS.map((day) => (
                                <option key={day} value={day}>
                                  {day}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                            <div>
                              <label className="form-label">
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
                                  className="control-input"
                              />
                            </div>

                            <div>
                                <label className="form-label">
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
                                  className="control-input"
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
                              className="btn-danger self-end"
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
                        className="btn-secondary"
                      >
                        Add schedule row
                      </button>
                    </div>

                    <div className="form-section">
                      <label className="form-label">Description</label>
                      <textarea
                        rows={3}
                        value={editForm.description}
                        onChange={(event) => setEditForm((prev) => ({ ...prev, description: event.target.value }))}
                        className="control-textarea"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={isSaving}
                        onClick={() => void saveEdit(item.id)}
                        className="btn-primary flex-1"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        disabled={isSaving}
                        onClick={() => setEditingId(null)}
                        className="btn-secondary flex-1"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className={`mt-0.5 inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl ${classIcon.iconWrapClass}`}>
                          <ClassIcon size={16} />
                        </span>
                        <div className="min-w-0">
                          <h3 className="truncate text-base font-semibold">{item.name}</h3>
                          <p className="mt-1 text-sm font-semibold text-brand-700">Monthly fee: Rs {item.monthlyFee.toLocaleString()}</p>
                          <p className="mt-0.5 text-xs text-muted">Week {item.paymentDueWeek} payment submission</p>
                        </div>
                      </div>
                      <p className="text-xs text-muted">
                        Created {new Date(item.createdAt).toLocaleDateString()}
                      </p>
                    </div>

                    <div className="mt-6">
                      <div className="tab-strip">
                        <button
                          type="button"
                          onClick={() => setActiveTabs((prev) => ({ ...prev, [item.id]: "details" }))}
                          className={`tab-btn inline-flex items-center gap-1.5 ${
                            activeTab === "details"
                              ? "tab-btn-active"
                              : "tab-btn-inactive"
                          }`}
                        >
                          <FileText size={13} />
                          Details
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveTabs((prev) => ({ ...prev, [item.id]: "schedule" }))}
                          className={`tab-btn inline-flex items-center gap-1.5 ${
                            activeTab === "schedule"
                              ? "tab-btn-active"
                              : "tab-btn-inactive"
                          }`}
                        >
                          <Clock3 size={13} />
                          Schedule
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveTabs((prev) => ({ ...prev, [item.id]: "students" }));
                            setIsCreatePanelOpen(false);
                            setStudentsPanelClassId(item.id);
                          }}
                          className={`tab-btn inline-flex items-center gap-1.5 ${
                            activeTab === "students"
                              ? "tab-btn-active"
                              : "tab-btn-inactive"
                          }`}
                        >
                          <Users size={13} />
                          Students
                        </button>
                      </div>
                    </div>

                    {activeTab === "details" ? (
                      <div className="mt-6 space-y-3">
                        <p className="surface-soft rounded-2xl p-5 text-sm text-muted">
                          {item.description || "No description provided."}
                        </p>
                        <p className="metric-badge">Summary: {item.schedule}</p>
                      </div>
                    ) : activeTab === "schedule" ? (
                      <div className="mt-6">
                        {item.schedules.length > 0 ? (
                          <div className="space-y-2">
                            {item.schedules.map((schedule) => (
                              <div
                                key={schedule.id}
                                className="schedule-card grid grid-cols-[90px_1fr] items-center text-sm"
                              >
                                <span className="font-semibold text-foreground">{getDayShortLabel(schedule.dayOfWeek)}</span>
                                <span className="text-muted">
                                  {schedule.startTime} - {schedule.endTime}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="empty-state">
                            <span className="empty-state__icon"><CalendarDays size={16} /></span>
                            <p className="text-sm text-muted">No schedules configured for this class.</p>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="mt-6 space-y-4">
                        <div className="surface-soft rounded-2xl p-5">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Class roster</p>
                          <p className="mt-2 text-sm text-muted">Open this class roster in a side panel for a focused student view.</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <span className="metric-badge">Active {activeStudents.length}</span>
                            <span className="metric-badge">Past {pastStudents.length}</span>
                            <span className="metric-badge">Total {item.students.length}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setStudentsPanelClassId(item.id)}
                            className="btn-secondary mt-4"
                          >
                            Open students panel
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="mt-6 flex gap-3">
                      <button
                        type="button"
                        onClick={() => beginEdit(item)}
                        className="btn-secondary flex-1 gap-2"
                      >
                        <Pencil size={14} />
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={isSaving}
                        onClick={() => void deleteClass(item.id)}
                        className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-rose-100 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-600 shadow-soft transition-all duration-180 hover:bg-rose-100 disabled:opacity-60"
                      >
                        <Trash2 size={14} />
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-6 flex items-center justify-between">
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
        className={`drawer-panel transition-transform duration-300 ${
          isCreatePanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="sticky top-0 z-10 -mx-6 mb-6 border-b border-brand-200 bg-white/90 px-6 pb-4 pt-1 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-100 text-brand-700">
                <GraduationCap size={18} />
              </span>
              <div>
                <h3 className="text-xl font-semibold">Add class</h3>
                <p className="mt-1 text-sm text-muted">Add class details and schedules for your students.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsCreatePanelOpen(false)}
              className="btn-ghost"
            >
              Close
            </button>
          </div>
        </div>

        <form className="space-y-4" onSubmit={handleCreate}>
          <div className="form-section">
            <label htmlFor="className" className="form-label">
              Class name
            </label>
            <input
              id="className"
              required
              value={createForm.name}
              onChange={(event) => setCreateForm((prev) => ({ ...prev, name: event.target.value }))}
              className="control-input"
              placeholder="Math - Grade 7"
            />
          </div>

          <div className="form-section">
            <label htmlFor="classMonthlyFee" className="form-label">
              Monthly fee (LKR)
            </label>
            <input
              id="classMonthlyFee"
              type="number"
              min="0"
              required
              value={createForm.monthlyFee}
              onChange={(event) => setCreateForm((prev) => ({ ...prev, monthlyFee: event.target.value }))}
              className="control-input"
              placeholder="2500"
            />
          </div>

          <div className="form-section">
            <label htmlFor="classPaymentDueWeek" className="form-label">
              Payment due week
            </label>
            <select
              id="classPaymentDueWeek"
              required
              value={createForm.paymentDueWeek}
              onChange={(event) => setCreateForm((prev) => ({ ...prev, paymentDueWeek: event.target.value }))}
              className="control-select"
            >
              <option value="1">First week</option>
              <option value="2">Second week</option>
              <option value="3">Third week</option>
              <option value="4">Fourth week</option>
            </select>
          </div>

          <div className="form-section">
            <label className="form-label">Class schedules</label>
            <div className="space-y-3">
              {createForm.schedules.map((schedule, index) => (
                <div key={`${schedule.dayOfWeek}-${index}`} className="schedule-card">
                  <div>
                    <label className="form-label">
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
                        className="control-select"
                    >
                      {WEEK_DAYS.map((day) => (
                        <option key={day} value={day}>
                          {day}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <div>
                      <label className="form-label">
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
                          className="control-input"
                      />
                    </div>

                    <div>
                        <label className="form-label">
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
                          className="control-input"
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
                      className="btn-danger self-end"
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
              className="btn-secondary mt-2"
            >
              Add schedule row
            </button>
          </div>

          <div className="form-section">
            <label htmlFor="classScheduleSummary" className="form-label">
              Schedule summary (optional)
            </label>
            <input
              id="classScheduleSummary"
              value={createForm.schedules
                .map((row) => `${getDayShortLabel(row.dayOfWeek)} ${row.startTime}-${row.endTime}`)
                .join(" | ")}
              readOnly
              className="control-input"
              placeholder="Auto-generated from schedule rows"
            />
          </div>

          <div className="form-section">
            <label htmlFor="classDescription" className="form-label">
              Description
            </label>
            <textarea
              id="classDescription"
              rows={4}
              value={createForm.description}
              onChange={(event) => setCreateForm((prev) => ({ ...prev, description: event.target.value }))}
              className="control-textarea"
              placeholder="Weekly class focus and outcomes"
            />
          </div>

          <button
            type="submit"
            disabled={isSaving}
            className="btn-primary w-full"
          >
            {isSaving ? "Saving..." : "Create class"}
          </button>
        </form>
      </aside>

      <button
        type="button"
        aria-label="Close students panel"
        onClick={() => setStudentsPanelClassId(null)}
        className={`fixed inset-0 z-40 bg-black/40 transition ${studentsPanelClassId ? "visible opacity-100" : "invisible opacity-0"}`}
      />

      <aside
        className={`drawer-panel transition-transform duration-300 ${
          studentsPanelClassId ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="sticky top-0 z-10 -mx-6 mb-6 border-b border-brand-200 bg-white/90 px-6 pb-4 pt-1 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-100 text-brand-700">
                <Users size={18} />
              </span>
              <div>
                <h3 className="text-xl font-semibold">Students</h3>
                <p className="mt-1 text-sm text-muted">{studentsPanelClass?.name ?? "Class"}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setStudentsPanelClassId(null)}
              className="btn-ghost"
            >
              Close
            </button>
          </div>
        </div>

        <div className="space-y-4">
          <div className="surface-soft rounded-2xl p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Overview</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="metric-badge">Active {studentsPanelActiveStudents.length}</span>
              <span className="metric-badge">Past {studentsPanelPastStudents.length}</span>
              <span className="metric-badge">Total {(studentsPanelClass?.students.length ?? 0)}</span>
            </div>
          </div>

          <div className="surface-soft rounded-2xl p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Active students ({studentsPanelActiveStudents.length})</p>
            {studentsPanelActiveStudents.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No active students currently assigned.</p>
            ) : (
              <div className="mt-2 space-y-2">
                {studentsPanelActiveStudents.map((entry) => (
                  <div key={entry.id} className="surface-soft rounded-2xl p-5">
                    <div className="flex items-start gap-3">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
                        {entry.student.name.slice(0, 2).toUpperCase()}
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-foreground">{entry.student.name}</p>
                        {entry.student.registrationNumber ? (
                          <span className="text-xs font-normal text-muted">({entry.student.registrationNumber})</span>
                        ) : null}
                        <p className="text-xs text-muted">Joined: {new Date(entry.assignedAt).toLocaleString()}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="surface-soft rounded-2xl p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Past students ({studentsPanelPastStudents.length})</p>
            {studentsPanelPastStudents.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No past student records yet.</p>
            ) : (
              <div className="mt-2 space-y-2">
                {studentsPanelPastStudents.map((entry) => (
                  <div key={entry.id} className="surface-soft rounded-2xl p-5">
                    <div className="flex items-start gap-3">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
                        {entry.student.name.slice(0, 2).toUpperCase()}
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-foreground">{entry.student.name}</p>
                        {entry.student.registrationNumber ? (
                          <span className="text-xs font-normal text-muted">({entry.student.registrationNumber})</span>
                        ) : null}
                        <p className="text-xs text-muted">Joined: {new Date(entry.assignedAt).toLocaleString()}</p>
                        <p className="text-xs text-muted">Removed: {entry.removedAt ? new Date(entry.removedAt).toLocaleString() : "-"}</p>
                        {entry.removeReason ? <p className="text-xs text-muted">Reason: {entry.removeReason}</p> : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>

      {isHelpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6">
          <div className="w-full max-w-3xl rounded-3xl border border-brand-200 bg-white/95 p-6 shadow-panel backdrop-blur">
            <div className="mb-5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-100 text-brand-700">
                  <CircleHelp size={18} />
                </span>
                <h2 className="text-2xl font-semibold">Class Management</h2>
              </div>
              <button
                onClick={() => setIsHelpOpen(false)}
                className="btn-secondary"
              >
                Close
              </button>
            </div>
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="surface-soft rounded-2xl p-5">
                <h3 className="font-semibold">Create Classes</h3>
                <p className="mt-1 text-muted">Add new teaching classes with names, descriptions, and weekly schedules. Define which days and times each class meets.</p>
              </div>
              <div className="surface-soft rounded-2xl p-5">
                <h3 className="font-semibold">Edit Class Details</h3>
                <p className="mt-1 text-muted">Update class information and schedules after creation. Click the edit button on any class card to modify its details.</p>
              </div>
              <div className="surface-soft rounded-2xl p-5">
                <h3 className="font-semibold">Filter & Search</h3>
                <p className="mt-1 text-muted">Use name and schedule filters to find specific classes. Apply filters to narrow results or clear to see all classes.</p>
              </div>
              <div className="surface-soft rounded-2xl p-5">
                <h3 className="font-semibold">Manage Schedules</h3>
                <p className="mt-1 text-muted">Add multiple schedule rows per class to define complex weekly patterns. Each row specifies a day and start/end time.</p>
              </div>
              <div className="surface-soft rounded-2xl p-5 sm:col-span-2">
                <h3 className="font-semibold">How to Use</h3>
                <ol className="mt-2 list-inside list-decimal space-y-1 text-muted">
                  <li>Click &ldquo;Add class&rdquo; to open the creation form</li>
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
