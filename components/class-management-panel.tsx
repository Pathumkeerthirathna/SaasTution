"use client";

import { useRouter } from "next/navigation";

import Link from "next/link";
import { ExternalLink, Eye } from "lucide-react";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Calendar,
  CalendarDays,
  CheckSquare2,
  CircleHelp,
  GraduationCap,
  Layers3,
  Pencil,
  RotateCcw,
  Search,
  Square,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  Wallet,
  X
} from "lucide-react";

export type ClassItem = {
  id: string;
  name: string;
  description: string | null;
  monthlyFee: number;
  paymentDueWeek: number;
  startDate: string;
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
  startDate: string;
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

type TeacherStudent = {
  id: string;
  name: string;
  grade: { id: string; GradeDesc: string } | null;
  registrationNumber: string | null;
  email: string | null;
  contact01: string | null;
  status: number;
  classes: { id: string; class: { name: string } }[];
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

function formatTime12h(time: string): string {
  const [hourStr, minute] = time.split(":");
  const hour = parseInt(hourStr, 10);
  const ampm = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${minute} ${ampm}`;
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
    startDate: "",
    schedules: [getDefaultScheduleRow()],
  });
  const [isCreatePanelOpen, setIsCreatePanelOpen] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isEditPanelOpen, setIsEditPanelOpen] = useState(false);
  const [editForm, setEditForm] = useState<FormState>({
    name: "",
    description: "",
    monthlyFee: "0",
    startDate: "",
    paymentDueWeek: "1",
    schedules: [getDefaultScheduleRow()],
  });
  const [totalItems, setTotalItems] = useState(0);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [studentsPanelClassId, setStudentsPanelClassId] = useState<string | null>(null);

  // Add-students modal
  const [isAddStudentsOpen, setIsAddStudentsOpen] = useState(false);
  const [availableStudents, setAvailableStudents] = useState<TeacherStudent[]>([]);
  const [isLoadingAvailableStudents, setIsLoadingAvailableStudents] = useState(false);
  const [studentSearchQuery, setStudentSearchQuery] = useState("");
  const [selectedStudentIds, setSelectedStudentIds] = useState<Set<string>>(new Set());
  const [isAssigning, setIsAssigning] = useState(false);

  // Remove-student confirmation
  const [removingEntry, setRemovingEntry] = useState<{ studentId: string; name: string } | null>(null);
  const [removeReason, setRemoveReason] = useState("");
  const [isRemoving, setIsRemoving] = useState(false);
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
  const activeStudentIdSet = useMemo(
    () => new Set(studentsPanelActiveStudents.map((e) => e.student.id)),
    [studentsPanelActiveStudents]
  );
  const filteredAvailableStudents = useMemo(() => {
    if (!studentSearchQuery.trim()) return availableStudents;
    const q = studentSearchQuery.toLowerCase();
    return availableStudents.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.registrationNumber?.toLowerCase().includes(q) ?? false) ||
        (s.grade?.GradeDesc.toLowerCase().replace("grade_0", "grade ").replace("grade_", "grade ").includes(q) ?? false)
    );
  }, [availableStudents, studentSearchQuery]);
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

   const router = useRouter();

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
      setTotalItems(payload.pagination?.totalItems ?? 0);
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

      console.log("createForm", createForm);

      //return;

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
        startDate: "",
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
    setIsEditPanelOpen(true);
    setEditForm({
      name: item.name,
      description: item.description ?? "",
      monthlyFee: String(item.monthlyFee),
      paymentDueWeek: String(item.paymentDueWeek),
      startDate: item.startDate,
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
      setIsEditPanelOpen(false);
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

    alert("Deleting a class will remove all associated schedules and student assignments. This action cannot be undone.");

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

      console.log({ response });

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

  const loadAvailableStudents = useCallback(async () => {
    setIsLoadingAvailableStudents(true);
    try {
      const res = await fetch("/api/students?pageSize=200&page=1");
      const payload = (await res.json()) as { success: boolean; data?: TeacherStudent[] };
      if (payload.success && payload.data) {
        setAvailableStudents(payload.data);
      }
    } catch {
      // silently fail — error visible via empty list
    } finally {
      setIsLoadingAvailableStudents(false);
    }
  }, []);

  function openAddStudents() {
    setSelectedStudentIds(new Set());
    setStudentSearchQuery("");
    setIsAddStudentsOpen(true);
    void loadAvailableStudents();
  }

  async function handleAssignStudents() {
    if (!studentsPanelClassId || selectedStudentIds.size === 0) return;
    setIsAssigning(true);
    try {
      await Promise.all(
        Array.from(selectedStudentIds).map((studentId) =>
          fetch("/api/students/assign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ classId: studentsPanelClassId, studentId }),
          })
        )
      );
      setIsAddStudentsOpen(false);
      setSelectedStudentIds(new Set());
      setStudentSearchQuery("");
      await loadClasses(page, filters);
      window.dispatchEvent(new CustomEvent(CLASS_CONFIG_UPDATED_EVENT));
    } catch {
      // silently fail
    } finally {
      setIsAssigning(false);
    }
  }

  async function handleRemoveStudent() {
    if (!studentsPanelClassId || !removingEntry) return;
    setIsRemoving(true);
    try {
      await fetch("/api/students/remove-from-class", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classId: studentsPanelClassId,
          studentId: removingEntry.studentId,
          reason: removeReason.trim() || undefined,
        }),
      });
      setRemovingEntry(null);
      setRemoveReason("");
      await loadClasses(page, filters);
      window.dispatchEvent(new CustomEvent(CLASS_CONFIG_UPDATED_EVENT));
    } catch {
      // silently fail
    } finally {
      setIsRemoving(false);
    }
  }

  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute -left-28 -top-28 h-80 w-80 rounded-full bg-brand-100 blur-3xl" />
      <div className="pointer-events-none absolute -right-24 top-20 h-72 w-72 rounded-full bg-cyan-100 blur-3xl" />

      <article
          className="
            relative
            space-y-5
            rounded-xl
            border
            border-slate-200
            bg-white
            p-6
            shadow-sm
          "
        >
        {/* <div className="hero-shell">

        </div> */}

          {/* Premium Compact SaaS Header */}
          <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">

            {/* Background */}
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute -right-24 -top-24 h-44 w-44 rounded-full bg-orange-100/60 blur-3xl" />
              <div className="absolute -left-16 bottom-0 h-36 w-36 rounded-full bg-emerald-100/70 blur-3xl" />
            </div>

            <div className="relative px-4 py-3">

              <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">

                {/* Left */}
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 via-green-500 to-orange-500 text-white shadow-sm">
                    <GraduationCap size={22} />
                  </div>

                  <div>
                    <h1 className="text-2xl font-bold text-slate-900">
                      Class Management
                    </h1>

                    <p className="mt-1 text-sm text-slate-500">
                      Manage classes, schedules and student enrolments.
                    </p>
                  </div>
                </div>

                {/* Right */}
                <div className="flex flex-col items-end gap-3">

                  <div className="flex flex-wrap justify-end gap-2">

                    {/* Classes */}
                    <div className="min-w-[95px] rounded-xl border border-slate-200 bg-white px-4 py-2.5">
                      <div className="flex items-center gap-2 text-emerald-600">
                          <Layers3 size={14}/>
                          <span className="text-[11px] font-semibold uppercase">
                              Classes
                          </span>
                      </div>

                      <div className="mt-1 text-xl font-bold text-slate-900">
                          {overview.totalClasses}
                      </div>
                  </div>

                    {/* Students */}
                    <div className="min-w-[105px] rounded-xl border border-slate-200 bg-white px-4 py-3">

                      <div className="flex items-center gap-1.5 text-orange-600">
                        <Users size={13} />
                        <span className="text-[10px] font-semibold uppercase tracking-wide">
                          Students
                        </span>
                      </div>

                      <p className="mt-1 text-xl font-bold text-slate-900">
                        {overview.activeStudents}
                      </p>

                    </div>

                    {/* Sessions */}
                    <div className="min-w-[105px] rounded-xl border border-slate-200 bg-white px-4 py-3">

                      <div className="flex items-center gap-1.5 text-green-600">
                        <CalendarDays size={13} />
                        <span className="text-[10px] font-semibold uppercase tracking-wide">
                          Sessions
                        </span>
                      </div>

                      <p className="mt-1 text-xl font-bold text-slate-900">
                        {overview.scheduleSlots}
                      </p>

                    </div>

                    {/* Fee */}
                    <div className="min-w-[130px] rounded-xl border border-slate-200 bg-white px-4 py-3">

                      <div className="flex items-center gap-1.5 text-amber-600">
                        <Wallet size={13} />
                        <span className="text-[10px] font-semibold uppercase tracking-wide">
                          Avg. Fee
                        </span>
                      </div>

                      <p className="mt-1 text-lg font-bold text-slate-900">
                        Rs. {overview.averageFee.toLocaleString()}
                      </p>

                    </div>

                  </div>

                  <div className="flex gap-2">

                    <button
                      type="button"
                      onClick={() => setIsHelpOpen(true)}
                      className="
                        inline-flex
                        h-9
                        items-center
                        gap-2
                        rounded-lg
                        border
                        border-slate-200
                        bg-white
                        px-4
                        text-xs
                        font-semibold
                        text-slate-700
                        transition
                        hover:border-orange-200
                        hover:bg-orange-50
                      "
                    >
                      <CircleHelp size={14} />
                      Help
                    </button>

                    <button
                      type="button"
                      onClick={() => setIsCreatePanelOpen(true)}
                      className="
                        inline-flex
                        h-9
                        items-center
                        gap-2
                        rounded-lg
                        bg-gradient-to-r
                        from-emerald-500
                        via-green-500
                        to-orange-500
                        px-5
                        text-xs
                        font-semibold
                        text-white
                        shadow-md
                        shadow-emerald-200
                        transition
                        hover:scale-[1.02]
                      "
                    >
                      <BookOpen size={14} />
                      New Class
                    </button>

                  </div>

                </div>

              </div>

            </div>

          </div>

          
        {successMessage && (
          <div className="fixed top-5 right-5 z-[100]">
            <div className="flex min-w-[320px] items-center gap-3 rounded-xl border border-emerald-200 bg-white p-4 shadow-xl">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
                <CheckSquare2 size={18} className="text-emerald-600" />
              </div>

              <div className="flex-1">
                <p className="text-sm font-semibold text-slate-900">
                  Class created successfully
                </p>

                <p className="text-xs text-slate-500">
                  Students can now be assigned to this class.
                </p>
              </div>

              <button
                onClick={() => setSuccessMessage(null)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        )}

        {isLoading ? <p className="mt-6 text-sm text-muted">Loading classes...</p> : null}

        {!isLoading && !hasData ? (
          <div className="mt-8 rounded-2xl border border-dashed border-border bg-muted/20 p-12">
            <div className="mx-auto flex max-w-lg flex-col items-center text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
                <GraduationCap className="h-8 w-8 text-primary" />
              </div>

              <h3 className="mt-5 text-lg font-semibold text-foreground">
                No classes yet
              </h3>

              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Get started by creating your first class. You can then
                assign students, manage lessons, track attendance and
                collect payments from one place.
              </p>

              <button
                type="button"
                onClick={() => setIsCreatePanelOpen(true)}
                className="btn-primary mt-6"
              >
                Create First Class
              </button>
            </div>
          </div>
        ) : null}

        <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
          {items.map((item) => {
            return (
             <div
                key={item.id}
                className="group overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-emerald-200 hover:shadow-xl"
              >
                {/* Header */}
                <div className="bg-gradient-to-r from-emerald-500 to-emerald-600 p-5 text-white">
                  <div className="flex items-start justify-between">
                    {/* Left */}
                    <div className="flex items-center gap-4">
                      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/15 backdrop-blur">
                        <BookOpen className="h-7 w-7" />
                      </div>

                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-xl font-bold">
                            {item.name}
                          </h3>

                          <span className="rounded-full bg-white/20 px-2.5 py-1 text-xs font-semibold">
                            ● Active
                          </span>
                        </div>

                        <p className="mt-1 text-sm text-emerald-100">
                          General
                        </p>
                      </div>
                    </div>

                    {/* Right */}
                    <div className="flex flex-col items-end justify-between text-right">
                      <span className="text-xs text-emerald-100">
                        Created {new Date(item.createdAt).toLocaleDateString()}
                      </span>

                      {item.startDate && (
                        <div className="mt-6 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white backdrop-blur">
                          📅 Upcoming:{" "}
                          {new Date(item.startDate).toLocaleDateString("en-GB", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Body */}
                <div className="space-y-5 p-5">

                  {/* Stats */}
                  <div className="grid grid-cols-3 gap-3">

                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div className="flex items-center gap-2 text-emerald-600">
                        <Users size={15} />
                        <span className="text-xs font-semibold">
                          Students
                        </span>
                      </div>

                      <p className="mt-2 text-xl font-bold text-slate-900">
                        {overview.activeStudents}
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div className="flex items-center gap-2 text-orange-600">
                        <Wallet size={15} />
                        <span className="text-xs font-semibold">
                          Monthly Fee
                        </span>
                      </div>

                      <p className="mt-2 text-lg font-bold text-orange-600">
                        Rs. {item.monthlyFee.toLocaleString()}
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div className="flex items-center gap-2 text-indigo-600">
                        <Calendar size={15} />
                        <span className="text-xs font-semibold">
                          Due Week
                        </span>
                      </div>

                      <p className="mt-2 text-lg font-bold text-indigo-700">
                        Week {item.paymentDueWeek}
                      </p>
                    </div>

                  </div>

                  {/* Schedule */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">

                    <div className="mb-3 flex items-center gap-2">
                      <CalendarDays
                        className="h-4 w-4 text-orange-500"
                      />

                      <span className="font-semibold text-slate-800">
                        Weekly Schedule
                      </span>
                    </div>

                    {item.schedules?.length > 0 ? (
                      <div className="space-y-2">
                        {item.schedules.slice(0, 2).map((schedule) => (
                          <div
                            key={`${schedule.dayOfWeek}-${schedule.startTime}`}
                            className="flex items-center justify-between rounded-lg bg-white px-3 py-2"
                          >
                            <span className="text-sm font-medium text-slate-700">
                              {schedule.dayOfWeek}
                            </span>

                            <span className="text-sm text-slate-500">
                              {formatTime12h(schedule.startTime)}
                              {" - "}
                              {formatTime12h(schedule.endTime)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-slate-500">
                        Schedule not available
                      </p>
                    )}

                  </div>

                  {/* Description */}
                  <p className="line-clamp-2 text-sm leading-6 text-slate-600">
                    {item.description ||
                      "No class description provided."}
                  </p>

                  {/* Footer */}
                  <div className="grid grid-cols-4 gap-2 border-t border-slate-100 pt-4">

                    <button
                      onClick={() => setStudentsPanelClassId(item.id)}
                      className="rounded-xl bg-emerald-600 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700"
                    >
                      Students
                    </button>

                    <button
                      className="rounded-xl border border-slate-200 py-2 text-sm font-medium hover:bg-slate-50"
                    >
                      Schedule
                    </button>

                    <button
                      onClick={() => beginEdit(item)}
                      className="rounded-xl border border-slate-200 py-2 text-sm font-medium hover:bg-slate-50"
                    >
                      Edit
                    </button>

                    <button
                      onClick={() => void deleteClass(item.id)}
                      className="rounded-xl border border-rose-200 bg-rose-50 py-2 text-sm font-medium text-rose-600 hover:bg-rose-100"
                    >
                      Delete
                    </button>

                  </div>

                </div>
              </div>

            );
          })}
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">
            Showing {items.length > 0 ? (page - 1) * PAGE_SIZE + 1 : 0} to {(page - 1) * PAGE_SIZE + items.length} of {totalItems} classes
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1 || isLoading}
              onClick={() => void loadClasses(page - 1, filters)}
              className="btn-ghost"
            >
              Previous
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                type="button"
                disabled={isLoading}
                onClick={() => void loadClasses(p, filters)}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-sm font-semibold transition-colors ${
                  p === page
                    ? "bg-brand-700 text-white"
                    : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                {p}
              </button>
            ))}
            <button
              type="button"
              disabled={page >= totalPages || isLoading}
              onClick={() => void loadClasses(page + 1, filters)}
              className="btn-ghost"
            >
              Next
            </button>
          </div>
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


        <div className="sticky top-0 z-10 -mx-6 mb-6 border-b border-border bg-background/95 px-6 py-4 backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-100 text-brand-700 shadow-sm">
                <GraduationCap size={22} />
              </div>

              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-xl font-semibold tracking-tight text-foreground">
                    Create New Class
                  </h3>

                  <span className="rounded-full bg-brand-100 px-2.5 py-1 text-xs font-medium text-brand-700">
                    Setup
                  </span>
                </div>

                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  Configure class information, payment settings and weekly schedules.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsCreatePanelOpen(false)}
              className="inline-flex h-10 items-center rounded-xl border border-border bg-background px-4 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              Close
            </button>
          </div>
        </div>

        <form className="space-y-5" onSubmit={handleCreate}>

                {/* {errorMessage ? (

                <p className="notice-error mt-6">{errorMessage}</p>
              ) : null} */}

              {errorMessage && (
                <div className="fixed bottom-5 right-5 z-[100]">
                  <div className="flex min-w-[320px] items-start gap-3 rounded-xl border border-red-200 bg-white p-4 shadow-xl">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100">
                      <AlertTriangle size={18} className="text-red-600" />
                    </div>

                    <div className="flex-1">
                      <p className="text-sm font-semibold text-slate-900">
                        Validation Error
                      </p>

                      <p className="text-xs text-slate-500">
                        {errorMessage}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => setErrorMessage(null)}
                      className="text-slate-400 transition hover:text-slate-600"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
              )}

          {/* Basic Information */}
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-5">
              <h3 className="text-base font-semibold text-foreground">
                Basic Information
              </h3>
              <p className="text-sm text-muted-foreground">
                Configure the core details of your class.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="className" className="form-label">
                  Class name
                </label>
                <input
                  id="className"
                  required
                  value={createForm.name}
                  onChange={(event) =>
                    setCreateForm((prev) => ({
                      ...prev,
                      name: event.target.value,
                    }))
                  }
                  className="control-input"
                  placeholder="Math - Grade 7"
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label htmlFor="classMonthlyFee" className="form-label">
                    Monthly fee (LKR)
                  </label>
                  <input
                    id="classMonthlyFee"
                    type="number"
                    min="0"
                    required
                    value={createForm.monthlyFee}
                    onChange={(event) =>
                      setCreateForm((prev) => ({
                        ...prev,
                        monthlyFee: event.target.value,
                      }))
                    }
                    className="control-input"
                    placeholder="2500"
                  />
                </div>

                <div>
                  <label htmlFor="classPaymentDueWeek" className="form-label">
                    Payment due week
                  </label>
                  <select
                    id="classPaymentDueWeek"
                    required
                    value={createForm.paymentDueWeek}
                    onChange={(event) =>
                      setCreateForm((prev) => ({
                        ...prev,
                        paymentDueWeek: event.target.value,
                      }))
                    }
                    className="control-select"
                  >
                    <option value="1">First week</option>
                    <option value="2">Second week</option>
                    <option value="3">Third week</option>
                    <option value="4">Fourth week</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Schedule Section */}
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            
            <div className="mb-5 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-foreground">
                  Class Schedules
                </h3>
                <p className="text-sm text-muted-foreground">
                  Configure weekly class sessions.
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  setCreateForm((prev) => ({
                    ...prev,
                    schedules: [...prev.schedules, getDefaultScheduleRow()],
                  }));
                }}
                className="btn-secondary"
              >
                Add Schedule
              </button>

            </div>

            {/* Batch Start Date */}
            <div className="mb-6 grid gap-4 md:grid-cols-2">
              <div>
                <label className="form-label">
                  Batch Start Date
                </label>

                <input
                  type="date"
                  value={createForm.startDate}
                  onChange={(e) =>
                    setCreateForm((prev) => ({
                      ...prev,
                      startDate: e.target.value,
                    }))
                  }
                  className="control-input"
                />

                <p className="mt-1 text-xs text-slate-500">
                  Date when this batch begins.
                </p>
              </div>

              <div>
                <label className="form-label">
                  Preview
                </label>

                <div className="flex h-[42px] items-center rounded-lg border border-slate-200 bg-slate-50 px-3">
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      createForm.startDate &&
                      new Date(createForm.startDate) > new Date()
                        ? "bg-orange-100 text-orange-700"
                        : "bg-emerald-100 text-emerald-700"
                    }`}
                  >
                    {createForm.startDate &&
                    new Date(createForm.startDate) > new Date()
                      ? "Upcoming Batch"
                      : "Running Batch"}
                  </span>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              {createForm.schedules.map((schedule, index) => (
                <div
                  key={`${schedule.dayOfWeek}-${index}`}
                  className="rounded-xl border border-border/70 bg-muted/20 p-4 transition-all hover:border-primary/30"
                >
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        Schedule {index + 1}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Configure day and timing
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={createForm.schedules.length <= 1}
                      onClick={() => {
                        setCreateForm((prev) => ({
                          ...prev,
                          schedules: prev.schedules.filter(
                            (_, itemIndex) => itemIndex !== index
                          ),
                        }));
                      }}
                      className="btn-danger"
                    >
                      Remove
                    </button>
                  </div>

                  <div className="grid gap-4 md:grid-cols-3">

                    <div>
                      <label className="form-label">
                        Day of week
                      </label>

                      <select
                        value={schedule.dayOfWeek}
                        onChange={(event) => {
                          const day =
                            event.target.value as FormState["schedules"][number]["dayOfWeek"];

                          setCreateForm((prev) => ({
                            ...prev,
                            schedules: prev.schedules.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, dayOfWeek: day }
                                : item
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
                              itemIndex === index
                                ? { ...item, startTime: value }
                                : item
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
                              itemIndex === index
                                ? { ...item, endTime: value }
                                : item
                            ),
                          }));
                        }}
                        className="control-input"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Additional Information */}
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-5">
              <h3 className="text-base font-semibold text-foreground">
                Additional Information
              </h3>
              <p className="text-sm text-muted-foreground">
                Optional details about the class.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="classScheduleSummary" className="form-label">
                  Schedule summary
                </label>

                <input
                  id="classScheduleSummary"
                  value={createForm.schedules
                    .map(
                      (row) =>
                        `${getDayShortLabel(row.dayOfWeek)} ${row.startTime}-${row.endTime}`
                    )
                    .join(" | ")}
                  readOnly
                  className="control-input"
                  placeholder="Auto-generated from schedule rows"
                />
              </div>

              <div>
                <label htmlFor="classDescription" className="form-label">
                  Description
                </label>

                <textarea
                  id="classDescription"
                  rows={4}
                  value={createForm.description}
                  onChange={(event) =>
                    setCreateForm((prev) => ({
                      ...prev,
                      description: event.target.value,
                    }))
                  }
                  className="control-textarea"
                  placeholder="Weekly class focus and outcomes"
                />
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={isSaving}
            className="btn-primary w-full"
          >
            {isSaving ? "Saving..." : "Create Class"}
          </button>
        </form>

      </aside>

      {/* Edit class panel */}
      <button
        type="button"
        aria-label="Close edit class panel"
        onClick={() => { setIsEditPanelOpen(false); setEditingId(null); }}
        className={`fixed inset-0 z-40 bg-black/40 transition ${isEditPanelOpen ? "visible opacity-100" : "invisible opacity-0"}`}
      />

      <aside
        className={`drawer-panel transition-transform duration-300 ${
          isEditPanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="sticky top-0 z-10 -mx-6 mb-6 border-b border-brand-200 bg-white/90 px-6 pb-4 pt-1 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-100 text-brand-700">
                <Pencil size={18} />
              </span>
              <div>
                <h3 className="text-xl font-semibold">Edit class</h3>
                <p className="mt-1 text-sm text-muted">Update class details and schedules.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => { setIsEditPanelOpen(false); setEditingId(null); }}
              className="btn-ghost"
            >
              Close
            </button>
          </div>
        </div>

        <div className="space-y-4">
          <div className="form-section">
            <label htmlFor="editClassName" className="form-label">
              Class name
            </label>
            <input
              id="editClassName"
              required
              value={editForm.name}
              onChange={(event) => setEditForm((prev) => ({ ...prev, name: event.target.value }))}
              className="control-input"
              placeholder="Math - Grade 7"
            />
          </div>

          <div className="form-section grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="editMonthlyFee" className="form-label">
                Monthly fee (LKR)
              </label>
              <input
                id="editMonthlyFee"
                type="number"
                min="0"
                required
                value={editForm.monthlyFee}
                onChange={(event) => setEditForm((prev) => ({ ...prev, monthlyFee: event.target.value }))}
                className="control-input"
                placeholder="2500"
              />
            </div>
            <div>
              <label htmlFor="editPaymentDueWeek" className="form-label">
                Payment due week
              </label>
              <select
                id="editPaymentDueWeek"
                value={editForm.paymentDueWeek}
                onChange={(event) => setEditForm((prev) => ({ ...prev, paymentDueWeek: event.target.value }))}
                className="control-select"
              >
                <option value="1">First week</option>
                <option value="2">Second week</option>
                <option value="3">Third week</option>
                <option value="4">Fourth week</option>
              </select>
            </div>
          </div>

          <div className="form-section">
            <label className="form-label">Class schedules</label>
            <div className="space-y-3">
              {editForm.schedules.map((schedule, index) => (
                <div key={`${schedule.dayOfWeek}-${index}`} className="schedule-card">
                  <div>
                    <label className="form-label">Day of week</label>
                    <select
                      value={schedule.dayOfWeek}
                      onChange={(event) => {
                        const day = event.target.value as FormState["schedules"][number]["dayOfWeek"];
                        setEditForm((prev) => ({
                          ...prev,
                          schedules: prev.schedules.map((s, i) =>
                            i === index ? { ...s, dayOfWeek: day } : s
                          ),
                        }));
                      }}
                      className="control-select"
                    >
                      {WEEK_DAYS.map((day) => (
                        <option key={day} value={day}>{day}</option>
                      ))}
                    </select>
                  </div>
                  <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <div>
                      <label className="form-label">Start time</label>
                      <input
                        type="time"
                        value={schedule.startTime}
                        onChange={(event) => {
                          const value = event.target.value;
                          setEditForm((prev) => ({
                            ...prev,
                            schedules: prev.schedules.map((s, i) =>
                              i === index ? { ...s, startTime: value } : s
                            ),
                          }));
                        }}
                        className="control-input"
                      />
                    </div>
                    <div>
                      <label className="form-label">End time</label>
                      <input
                        type="time"
                        value={schedule.endTime}
                        onChange={(event) => {
                          const value = event.target.value;
                          setEditForm((prev) => ({
                            ...prev,
                            schedules: prev.schedules.map((s, i) =>
                              i === index ? { ...s, endTime: value } : s
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
                          schedules: prev.schedules.filter((_, i) => i !== index),
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
              onClick={() => setEditForm((prev) => ({ ...prev, schedules: [...prev.schedules, getDefaultScheduleRow()] }))}
              className="btn-secondary mt-2"
            >
              Add schedule row
            </button>
          </div>

          <div className="form-section">
            <label className="form-label">Schedule summary</label>
            <input
              value={editForm.schedules.map((row) => `${getDayShortLabel(row.dayOfWeek)} ${row.startTime}-${row.endTime}`).join(" | ")}
              readOnly
              className="control-input"
            />
          </div>

          <div className="form-section">
            <label htmlFor="editDescription" className="form-label">
              Description
            </label>
            <textarea
              id="editDescription"
              rows={4}
              value={editForm.description}
              onChange={(event) => setEditForm((prev) => ({ ...prev, description: event.target.value }))}
              className="control-textarea"
              placeholder="Weekly class focus and outcomes"
            />
          </div>

          <button
            type="button"
            disabled={isSaving || !editingId}
            onClick={() => editingId && void saveEdit(editingId)}
            className="btn-primary w-full"
          >
            {isSaving ? "Saving..." : "Update class"}
          </button>
        </div>
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
        {/* Header */}
        {/* Header */}
        <div className="sticky top-0 z-10 -mx-6 mb-5 border-b border-slate-200 bg-white px-6 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-700">
                <Users size={16} />
              </span>

              <div>
                <h3 className="text-lg font-semibold text-slate-900">
                  Students
                </h3>

                <p className="mt-0.5 text-sm text-slate-500">
                  {studentsPanelClass?.name ?? "Class"}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openAddStudents}
                className="
                  inline-flex
                  h-9
                  items-center
                  gap-2
                  rounded-md
                  bg-brand-600
                  px-3
                  text-sm
                  font-medium
                  text-white
                  hover:bg-brand-700
                "
              >
                <UserPlus size={14} />
                Add Students
              </button>

              <button
                type="button"
                onClick={() => setStudentsPanelClassId(null)}
                className="
                  inline-flex
                  h-9
                  items-center
                  rounded-md
                  border
                  border-slate-200
                  px-3
                  text-sm
                  text-slate-600
                  hover:bg-slate-50
                "
              >
                Close
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {/* Overview */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Overview</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Active {studentsPanelActiveStudents.length}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-gray-600">
                Past {studentsPanelPastStudents.length}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
                Total {studentsPanelClass?.students.length ?? 0}
              </span>
            </div>
          </div>

          {/* Active Students */}
          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                Active students ({studentsPanelActiveStudents.length})
              </p>
            </div>
            {studentsPanelActiveStudents.length === 0 ? (
              <div className="px-5 py-6 text-center">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-gray-100">
                  <Users size={16} className="text-muted" />
                </span>
                <p className="mt-2 text-sm font-semibold text-foreground">No active students</p>
                <p className="text-xs text-muted">Add students using the button above.</p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-50">
                {studentsPanelActiveStudents.map((entry) => (
                  <li
                      key={entry.id}
                      className="
                        flex
                        items-center
                        justify-between
                        gap-3
                        px-4
                        py-3
                        transition-colors
                        hover:bg-slate-50
                      "
                    >
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                          className="
                            inline-flex
                            h-8
                            w-8
                            shrink-0
                            items-center
                            justify-center
                            rounded-md
                            bg-blue-50
                            text-xs
                            font-semibold
                            text-blue-700
                          "
                        >
                        {entry.student.name.slice(0, 2).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">{entry.student.name}</p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          {entry.student.registrationNumber ? (
                            <span className="text-xs text-muted">{entry.student.registrationNumber}</span>
                          ) : null}
                          <span className="text-xs text-muted">
                            Joined {new Date(entry.assignedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Link
                        href={`/dashboard/students/${entry.student.id}`}
                        className="
                          inline-flex
                          items-center
                          justify-center
                          rounded-md
                          border
                          border-slate-200
                          p-2
                          text-slate-600
                          transition-colors
                          hover:bg-slate-50
                          hover:text-brand-700
                        "
                        title="View Student Profile"
                      >
                        <Eye size={14} />
                      </Link>

                      <button
                        type="button"
                        onClick={() =>
                          setRemovingEntry({
                            studentId: entry.student.id,
                            name: entry.student.name,
                          })
                        }
                        className="
                          inline-flex
                          items-center
                          gap-1
                          rounded-md
                          border
                          border-rose-200
                          px-2.5
                          py-1.5
                          text-xs
                          font-medium
                          text-rose-600
                          transition-colors
                          hover:bg-rose-50
                        "
                      >
                        <UserMinus size={12} />
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Past Students */}
          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-gray-100 px-5 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                Past students ({studentsPanelPastStudents.length})
              </p>
            </div>
            {studentsPanelPastStudents.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted">No past student records yet.</p>
            ) : (
              <ul className="divide-y divide-gray-50">
                {studentsPanelPastStudents.map((entry) => (
                  <li key={entry.id} className="px-5 py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-bold text-gray-500">
                        {entry.student.name.slice(0, 2).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-semibold text-foreground">{entry.student.name}</p>
                          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-500">
                            Removed
                          </span>
                        </div>
                        {entry.student.registrationNumber ? (
                          <p className="text-xs text-muted">{entry.student.registrationNumber}</p>
                        ) : null}
                        <div className="mt-1.5 space-y-0.5">
                          <p className="flex items-center gap-1.5 text-xs text-muted">
                            <span className="font-medium text-gray-500">Joined:</span>
                            {new Date(entry.assignedAt).toLocaleString("en-GB", {
                              day: "2-digit", month: "short", year: "numeric",
                              hour: "2-digit", minute: "2-digit",
                            })}
                          </p>
                          <p className="flex items-center gap-1.5 text-xs text-muted">
                            <span className="font-medium text-rose-500">Removed:</span>
                            {entry.removedAt
                              ? new Date(entry.removedAt).toLocaleString("en-GB", {
                                  day: "2-digit", month: "short", year: "numeric",
                                  hour: "2-digit", minute: "2-digit",
                                })
                              : "—"}
                          </p>
                          {entry.removeReason ? (
                            <p className="flex items-start gap-1.5 text-xs text-muted">
                              <span className="font-medium text-gray-500">Reason:</span>
                              <span className="italic">{entry.removeReason}</span>
                            </p>
                          ) : null}
                        </div>
                      </div>

                      <Link
                          href={`/dashboard/students/${entry.student.id}`}
                          className="
                            flex h-8 w-8 items-center justify-center
                            rounded-lg
                            border border-slate-200
                            text-slate-500
                            transition
                            hover:border-brand-300
                            hover:bg-brand-50
                            hover:text-brand-700
                          "
                          title="View Student Profile"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Link>
                      
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>


        </div>
      </aside>

      {/* ── Add Students Panel ───────────────────────────────────── */}
      <button
        type="button"
        aria-label="Close add students panel"
        onClick={() => setIsAddStudentsOpen(false)}
        className={`fixed inset-0 z-50 bg-black/40 transition ${isAddStudentsOpen ? "visible opacity-100" : "invisible opacity-0"}`}
      />

      <aside
        className={`drawer-panel flex flex-col transition-transform duration-300 ${
          isAddStudentsOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Panel header */}
        <div className="sticky top-0 z-10 -mx-6 shrink-0 border-b border-brand-200 bg-white/90 px-6 pb-4 pt-1 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-100 text-brand-700">
                <UserPlus size={18} />
              </span>
              <div>
                <h3 className="text-xl font-semibold">Add students</h3>
                <p className="mt-1 text-sm text-muted">{studentsPanelClass?.name}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsAddStudentsOpen(false)}
              className="btn-ghost"
            >
              Close
            </button>
          </div>

          {/* Search */}
          <div className="mt-4">
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={studentSearchQuery}
                onChange={(e) => setStudentSearchQuery(e.target.value)}
                placeholder="Search by name or registration number..."
                className="control-input pl-9"
              />
            </div>
            {selectedStudentIds.size > 0 && (
              <p className="mt-2 text-xs font-semibold text-brand-700">
                {selectedStudentIds.size} student{selectedStudentIds.size !== 1 ? "s" : ""} selected
              </p>
            )}
          </div>
        </div>

        {/* Student list */}
        <div className="flex-1 overflow-y-auto -mx-6 px-4 py-3">
          {isLoadingAvailableStudents ? (
            <div className="flex items-center justify-center py-16">
              <p className="text-sm text-muted">Loading students...</p>
            </div>
          ) : filteredAvailableStudents.length === 0 ? (
            
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-100 text-brand-700">
                <Users size={28} />
              </div>

              <h3 className="mt-4 text-lg font-semibold text-foreground">
                No Students Available
              </h3>

              <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                There are no students available to assign to this class.
                Create a student first and then return here to enroll them.
              </p>

              <div className="mt-6 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => router.push("/dashboard/students")}
                  className="
                    inline-flex items-center gap-2
                    rounded-xl
                    border border-slate-200
                    px-4 py-2.5
                    text-sm font-medium
                    text-slate-600
                    transition
                    hover:bg-slate-50
                  "
                >
                  <RotateCcw size={16} />
                  Go to Students
                </button>

                

              </div>
            </div>




          ) : (
            <ul className="divide-y divide-gray-100">
              {filteredAvailableStudents.map((student) => {
                const isEnrolled = activeStudentIdSet.has(student.id);
                const isSelected = selectedStudentIds.has(student.id);
                return (
                  <li key={student.id}>
                    <button
                      type="button"
                      disabled={isEnrolled}
                      onClick={() => {
                        if (isEnrolled) return;
                        setSelectedStudentIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(student.id)) next.delete(student.id);
                          else next.add(student.id);
                          return next;
                        });
                      }}
                      className={`flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors ${
                        isEnrolled
                          ? "cursor-default opacity-50"
                          : isSelected
                          ? "bg-brand-50"
                          : "hover:bg-gray-50"
                      }`}
                    >
                      <span className={`shrink-0 ${isEnrolled ? "text-gray-300" : isSelected ? "text-brand-600" : "text-gray-300"}`}>
                        {isSelected ? <CheckSquare2 size={18} /> : <Square size={18} />}
                      </span>
                      <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                        isEnrolled ? "bg-gray-100 text-gray-400" : "bg-brand-100 text-brand-700"
                      }`}>
                        {student.name.slice(0, 2).toUpperCase()}
                      </span>
                      
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-foreground">{student.name}</p>
                        <div className="flex flex-wrap items-center gap-x-2">
                          {student.registrationNumber ? (
                            <span className="text-xs text-muted">{student.registrationNumber}</span>
                          ) : null}
                          {student.grade ? (
                            <span className="text-xs text-muted">
                              {student.grade.GradeDesc
                                .replace("GRADE_0", "Grade ")
                                .replace("GRADE_", "Grade ")}
                            </span>
                          ) : null}

                          {student.status === 0 ? (
                            <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">
                              Active
                            </span>
                          ) : (
                            <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                              Inactive
                            </span>
                          )}

                        </div>
                      </div>

                      {isEnrolled && (
                        <span className="shrink-0 rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-semibold text-emerald-700">
                          Enrolled
                        </span>
                      )}
                      {student.status !== 0 && (
                        <span className="shrink-0 rounded-full bg-red-100 px-2.5 py-1 text-[10px] font-semibold text-red-700">
                          Inactive
                        </span>
                      )}

                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer actions */}
        <div className="-mx-6 shrink-0 border-t border-brand-200 bg-white px-6 py-4">
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setIsAddStudentsOpen(false)}
              className="btn-ghost flex-1"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={selectedStudentIds.size === 0 || isAssigning}
              onClick={() => void handleAssignStudents()}
              className="btn-primary flex-1 gap-2"
            >
              <UserPlus size={14} />
              {isAssigning
                ? "Adding..."
                : selectedStudentIds.size > 0
                ? `Add ${selectedStudentIds.size} student${selectedStudentIds.size !== 1 ? "s" : ""}`
                : "Select students"}
            </button>
          </div>
        </div>
      </aside>

      {/* ── Remove Confirmation Modal ─────────────────────────────── */}
      {removingEntry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-panel">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-rose-100 text-rose-600">
                <AlertTriangle size={18} />
              </span>
              <div>
                <h3 className="text-base font-semibold text-foreground">Remove student?</h3>
                <p className="mt-1 text-sm text-muted">
                  <span className="font-semibold text-foreground">{removingEntry.name}</span> will be removed from{" "}
                  <span className="font-semibold text-foreground">{studentsPanelClass?.name}</span>. Their activity history will be preserved.
                </p>
              </div>
            </div>

            <div className="mt-5">
              <label htmlFor="removeReason" className="form-label">
                Reason <span className="font-normal text-muted">(optional)</span>
              </label>
              <textarea
                id="removeReason"
                rows={3}
                value={removeReason}
                onChange={(e) => setRemoveReason(e.target.value)}
                placeholder="e.g. Completed the course, transferred to another class..."
                className="control-textarea mt-1"
              />
            </div>

            <div className="mt-4 flex gap-3">
              <button
                type="button"
                disabled={isRemoving}
                onClick={() => { setRemovingEntry(null); setRemoveReason(""); }}
                className="btn-ghost flex-1"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isRemoving}
                onClick={() => void handleRemoveStudent()}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border border-rose-200 bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-soft transition-all hover:bg-rose-700 disabled:opacity-60"
              >
                <UserMinus size={14} />
                {isRemoving ? "Removing..." : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}

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
