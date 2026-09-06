"use client";

import { useRouter } from "next/navigation";

import Link from "next/link";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronUp, ExternalLink, Eye } from "lucide-react";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Atom,
  BookOpen,
  Calculator,
  Calendar,
  CalendarDays,
  CheckSquare2,
  CircleHelp,
  Clock,
  Compass,
  FileText,
  FlaskConical,
  GraduationCap,
  History,
  Layers3,
  Microscope,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Sigma,
  Square,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  Wallet,
  X
} from "lucide-react";
import { PaginatedStudentsResponse, StudentListItem } from "./student-guardian-management-panel";
import { formatStoredSriLankaDate, formatStoredSriLankaDateTime } from "@/lib/time";
import {
  ClassBookBadge,
  getClassBookLabel,
  getClassCardIcon,
  getClassCardTheme,
  getClassNumber,
} from "./class-card-visuals";

// Re-exported for callers that historically imported these from this module.
export {
  ClassBookBadge,
  getClassBookLabel,
  getClassCardIcon,
  getClassCardTheme,
  getClassNumber,
} from "./class-card-visuals";

type GradeItem = {
  id: number;
  GradeDesc: string;
};

type ClassFeeHistoryEntry = {
  id: string;
  amount: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  isCurrent: boolean;
};

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
    studentId:string;
    isActive: boolean;
    assignedAt: string;
    removedAt: string | null;
    removeReason: string | null;
    student: {
      id: string;
      name: string;
      registrationNumber: string | null;
      grade: { id: number; GradeDesc: string } | null;
    };
  }[];
  createdAt: string;
};

function formatGrade(gradeDesc: string | null | undefined) {
  if (!gradeDesc) return null;
  return gradeDesc.replace("GRADE_0", "Grade ").replace("GRADE_", "Grade ");
}

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
  registrationNumber: string;
  name: string;
  email: string;
  grade: string;
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

export function formatTime12h(time: string): string {
  const [hourStr, minute] = time.split(":");
  const hour = parseInt(hourStr, 10);
  const ampm = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${minute} ${ampm}`;
}

function ClassCardSkeleton() {
  return (
    <div className="animate-pulse overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="bg-slate-200 py-3 pl-4 pr-4 sm:pr-36">
        <div className="flex items-start gap-2">
          <div className="h-9 w-9 shrink-0 rounded-lg bg-white/30" />
          <div className="min-w-0 space-y-1.5">
            <div className="h-3.5 w-32 rounded bg-white/40" />
            <div className="h-2.5 w-20 rounded bg-white/25" />
          </div>
        </div>
        <div className="mt-3 h-2.5 w-24 rounded bg-white/25" />
      </div>

      <div className="space-y-3 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <div className="h-9 rounded-lg bg-slate-100" />
            <div className="h-9 rounded-lg bg-slate-100" />
            <div className="h-9 rounded-lg bg-slate-100" />
          </div>
          <div className="h-full min-h-[80px] rounded-lg bg-slate-100" />
        </div>

        <div className="h-3 w-full rounded bg-slate-100" />

        <div className="grid grid-cols-3 gap-1.5 border-t border-slate-100 pt-3">
          <div className="h-8 rounded-lg bg-slate-100" />
          <div className="h-8 rounded-lg bg-slate-100" />
          <div className="h-8 rounded-lg bg-slate-100" />
        </div>
      </div>
    </div>
  );
}

export function ClassManagementPanel() {
  const [items, setItems] = useState<ClassItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>({
    registrationNumber: "",
    name: "",
    email: "",
    grade: "",
  });

  const [grades, setGrades] = useState<GradeItem[]>([]);

  const loadGrades = useCallback(async () => {
    try {
      const response = await fetch("/api/Grade");

      if (!response.ok) return;

      const data = await response.json();

      setGrades(data);
    } catch (error) {
      console.error(error);
    }
  }, []);

  const [isFilterOpen, setIsFilterOpen] = useState(false);
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

  // Fee history modal
  const [feeHistoryClass, setFeeHistoryClass] = useState<{ id: string; name: string } | null>(null);
  const [feeHistory, setFeeHistory] = useState<ClassFeeHistoryEntry[]>([]);
  const [isFeeHistoryLoading, setIsFeeHistoryLoading] = useState(false);

  // Add-students modal
  const [isAddStudentsOpen, setIsAddStudentsOpen] = useState(false);
  const [availableStudents, setAvailableStudents] = useState<StudentListItem[]>([]);
  const [isLoadingAvailableStudents, setIsLoadingAvailableStudents] = useState(false);
  
  const [selectedStudentIds, setSelectedStudentIds] = useState<Set<string>>(new Set());
  const [isAssigning, setIsAssigning] = useState(false);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [pageSize, setPageSize] = useState(10);
  const [students, setStudents] = useState<StudentListItem[]>([]);
  const [studentPage, setStudentPage] = useState(1);
  const [studentTotalPages, setStudentTotalPages] = useState(1);
  const [studentTotalItems, setStudentTotalItems] = useState(0);

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

const selectableStudents = useMemo(
  () =>
    availableStudents.filter(
      (student) =>
        !activeStudentIdSet.has(student.id) &&
        student.status === 0
    ),
  [availableStudents, activeStudentIdSet]
);

const sortedAvailableStudents = useMemo(
  () =>
    [...availableStudents].sort((a, b) => {
      const aEnrolled = activeStudentIdSet.has(a.id) ? 0 : 1;
      const bEnrolled = activeStudentIdSet.has(b.id) ? 0 : 1;
      return aEnrolled - bEnrolled;
    }),
  [availableStudents, activeStudentIdSet]
);

useEffect(() => {
  void loadGrades();
}, [loadGrades]);

const isAllSelected =
  selectableStudents.length > 0 &&
  selectableStudents.every((student) =>
    selectedStudentIds.has(student.id)
  );

const hasStudentFilter = Boolean(
  filters.registrationNumber || filters.name || filters.email || filters.grade
);
  // const filteredAvailableStudents = useMemo(() => {
  //   if (!studentSearchQuery.trim()) return availableStudents;
  //   const q = studentSearchQuery.toLowerCase();
  //   return availableStudents.filter(
  //     (s) =>
  //       s.name.toLowerCase().includes(q) ||
  //       (s.registrationNumber?.toLowerCase().includes(q) ?? false) ||
  //       (s.grade?.GradeDesc.toLowerCase().replace("grade_0", "grade ").replace("grade_", "grade ").includes(q) ?? false)
  //   );
  // }, [availableStudents, studentSearchQuery]);

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

  const loadClasses = useCallback(async (nextPage = 1) => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const query = new URLSearchParams({
        page: String(nextPage),
        pageSize: String(PAGE_SIZE),
      });

      const response = await fetch(`/api/classes?${query.toString()}`);
      const payload = (await response.json()) as PaginatedResponse;

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to load classes.");
        return;
      }

      setItems(payload.data ?? []);

      console.log(payload.data);

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
  void loadClasses(1);
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
      await loadClasses(1);
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

  async function openFeeHistory(item: ClassItem) {
    setFeeHistoryClass({ id: item.id, name: item.name });
    setFeeHistory([]);
    setIsFeeHistoryLoading(true);

    try {
      const response = await fetch(`/api/classes/${item.id}/fee-history`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: ClassFeeHistoryEntry[];
      };

      if (!response.ok || !payload.success) {
        throw new Error("Failed to load fee history.");
      }

      setFeeHistory(payload.data ?? []);
    } catch {
      setFeeHistory([]);
    } finally {
      setIsFeeHistoryLoading(false);
    }
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
      await loadClasses(page);
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

      await loadClasses(nextPage);

    } catch {
      setErrorMessage("Unable to delete class right now.");
    } finally {
      setIsSaving(false);
    }
  }


  const [sortBy, setSortBy] = useState("CreatedAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  function handleSort(column: string) {
    const nextOrder =
      sortBy === column && sortOrder === "asc"
        ? "desc"
        : "asc";

    setSortBy(column);
    setSortOrder(nextOrder);

    void loadStudentList(
      1,
      filters,
      column,
      nextOrder
    );
  }

  const loadStudentList = useCallback(
      async (
        nextPage = 1,
        appliedFilters: FilterState = {
          registrationNumber: "",
          name: "",
          email: "",
          grade: "",
        },
        currentSortBy = sortBy,
        currentSortOrder = sortOrder,
        currentPageSize = pageSize
      ) => {
          setIsLoadingAvailableStudents(true);
          setErrorMessage(null);
  
          try {
            const query = new URLSearchParams({
              page: String(nextPage),
              pageSize: String(currentPageSize),
            });
  
            query.set("sortBy", currentSortBy);
            query.set("sortOrder", currentSortOrder);
  
            if (appliedFilters.registrationNumber.trim()) {
              query.set(
                "registrationNumber",
                appliedFilters.registrationNumber.trim()
              );
            }

            if (appliedFilters.name.trim()) {
              query.set("name", appliedFilters.name.trim());
            }

            if (appliedFilters.email.trim()) {
              query.set("email", appliedFilters.email.trim());
            }

            if (appliedFilters.grade) {
              query.set("grade", appliedFilters.grade);
            }
  
            console.log(
              `/api/students?${query.toString()}`
            );
  
            const response = await fetch(
              `/api/students?${query.toString()}`
            );
  
            const payload =
            (await response.json()) as PaginatedStudentsResponse;
  
            // if (!response.ok || !payload.success) {
            //   setErrorMessage(
            //     payload.error?.message ??
            //       "Failed to load students."
            //   );
            //   return;
            // }
  
            console.log(payload);

            if (payload.success && payload.data) {
              setAvailableStudents(payload.data);
            }
  
            setStudents(payload.data ?? []);
            setStudentPage(payload.pagination?.page ?? nextPage);
            setStudentTotalPages(
              payload.pagination?.totalPages ?? 1
            );
            setStudentTotalItems(
              payload.pagination?.totalItems ?? 0
            );
          } catch {
            setErrorMessage(
              "Unable to load students right now."
            );
          } finally {
            setIsLoadingAvailableStudents(false);
          }
        },
        [sortBy, sortOrder]
      );

  // const loadAvailableStudents = useCallback(async () => {
  //   setIsLoadingAvailableStudents(true);
  //   try {
  //     const res = await fetch("/api/students?pageSize=200&page=1");
      
  //     const payload = (await res.json()) as { success: boolean; data?: TeacherStudent[] };

  //     console.log(payload);

  //     if (payload.success && payload.data) {
  //       setAvailableStudents(payload.data);
  //     }

  //   } catch {
  //     // silently fail — error visible via empty list
  //   } finally {
  //     setIsLoadingAvailableStudents(false);
  //   }
  // }, []);

  function openAddStudents() {
    setSelectedStudentIds(new Set());
   
    setIsAddStudentsOpen(true);
    void loadStudentList();
  }

  async function handleAssignStudents() {
    if (!studentsPanelClassId || selectedStudentIds.size === 0) return;
    setIsAssigning(true);
    setSuccessMessage(null);
    setErrorMessage(null);

    const ids = Array.from(selectedStudentIds);
    const className = studentsPanelClass?.name ?? "the class";
    let assigned = 0;
    let firstError: string | null = null;

    try {
      const results = await Promise.all(
        ids.map(async (studentId) => {
          try {
            const response = await fetch("/api/students/assign", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ classId: studentsPanelClassId, studentId }),
            });
            const payload = (await response.json()) as {
              success: boolean;
              error?: { message?: string };
            };
            return { ok: response.ok && payload.success, message: payload.error?.message };
          } catch {
            return { ok: false, message: "Network error." };
          }
        })
      );

      for (const r of results) {
        if (r.ok) assigned += 1;
        else if (!firstError) firstError = r.message ?? "Failed to assign a student.";
      }

      if (assigned > 0) {
        await loadClasses(page);
        window.dispatchEvent(new CustomEvent(CLASS_CONFIG_UPDATED_EVENT));
        setSelectedStudentIds(new Set());
        setIsAddStudentsOpen(false);
        setSuccessMessage(
          `${assigned} student${assigned !== 1 ? "s" : ""} assigned to ${className}.` +
            (firstError ? " Some students could not be added." : "")
        );
      } else {
        setErrorMessage(firstError ?? "Could not assign the selected students.");
      }
    } catch {
      setErrorMessage("Could not assign the selected students.");
    } finally {
      setIsAssigning(false);
    }
  }

  async function handleRemoveStudent() {
    if (!studentsPanelClassId || !removingEntry) return;
    setIsRemoving(true);
    setSuccessMessage(null);
    setErrorMessage(null);

    const removedName = removingEntry.name;

    try {
      const response = await fetch("/api/students/remove-from-class", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classId: studentsPanelClassId,
          studentId: removingEntry.studentId,
          reason: removeReason.trim() || undefined,
        }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        error?: { message?: string };
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Could not remove the student.");
        return;
      }

      setRemovingEntry(null);
      setRemoveReason("");
      await loadClasses(page);
      window.dispatchEvent(new CustomEvent(CLASS_CONFIG_UPDATED_EVENT));
      setSuccessMessage(`${removedName} removed from the class.`);
    } catch {
      setErrorMessage("Could not remove the student.");
    } finally {
      setIsRemoving(false);
    }
  }

  return (
    <section>
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
          {/* Header */}
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">

            {/* Left */}
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#32598A] text-white">
                <GraduationCap size={18} />
              </div>

              <div>
                <h1 className="text-lg font-semibold tracking-tight text-slate-900">
                  Class Management
                </h1>

                <p className="text-xs text-slate-500">
                  Manage classes, schedules and student enrolments.
                </p>
              </div>
            </div>

            {/* Right */}
            <div className="flex flex-col items-start gap-2 lg:items-end">

              <div className="flex flex-wrap gap-1.5 lg:justify-end">

                {/* Classes */}
                <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
                  <div className="flex items-center gap-1 text-[#32598A]">
                    <Layers3 size={11} />
                    <span className="text-[10px] font-semibold uppercase tracking-wide">
                      Classes
                    </span>
                  </div>

                  <div className="text-sm font-bold text-slate-900">
                    {overview.totalClasses}
                  </div>
                </div>

                {/* Students */}
                <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
                  <div className="flex items-center gap-1 text-orange-600">
                    <Users size={11} />
                    <span className="text-[10px] font-semibold uppercase tracking-wide">
                      Students
                    </span>
                  </div>

                  <div className="text-sm font-bold text-slate-900">
                    {overview.activeStudents}
                  </div>
                </div>

                {/* Sessions */}
                <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
                  <div className="flex items-center gap-1 text-[#32598A]">
                    <CalendarDays size={11} />
                    <span className="text-[10px] font-semibold uppercase tracking-wide">
                      Sessions
                    </span>
                  </div>

                  <div className="text-sm font-bold text-slate-900">
                    {overview.scheduleSlots}
                  </div>
                </div>

                {/* Fee */}
                <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
                  <div className="flex items-center gap-1 text-amber-600">
                    <Wallet size={11} />
                    <span className="text-[10px] font-semibold uppercase tracking-wide">
                      Avg. Fee
                    </span>
                  </div>

                  <div className="text-sm font-bold text-slate-900">
                    Rs. {overview.averageFee.toLocaleString()}
                  </div>
                </div>

              </div>

              <div className="flex gap-2">

                <button
                  type="button"
                  onClick={() => setIsHelpOpen(true)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:border-orange-200 hover:bg-orange-50"
                >
                  <CircleHelp size={13} />
                  Help
                </button>

                <button
                  type="button"
                  onClick={() => setIsCreatePanelOpen(true)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#32598A] px-3 text-xs font-semibold text-white shadow-sm transition hover:bg-[#264867]"
                >
                  <BookOpen size={13} />
                  New Class
                </button>

              </div>

            </div>

          </div>


        {successMessage && (
          <div className="fixed inset-x-5 top-5 z-[100] sm:inset-x-auto sm:right-5">
            <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-white p-4 shadow-xl sm:min-w-[320px]">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
                <CheckSquare2 size={18} className="text-emerald-600" />
              </div>

              <div className="flex-1">
                <p className="text-sm font-semibold text-slate-900">
                  {successMessage}
                </p>

                {successMessage === "Class created successfully." && (
                  <p className="text-xs text-slate-500">
                    Students can now be assigned to this class.
                  </p>
                )}
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

        {isLoading ? (
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: PAGE_SIZE }).map((_, index) => (
              <ClassCardSkeleton key={index} />
            ))}
          </div>
        ) : null}

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

        {!isLoading ? (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => {
            const theme = getClassCardTheme(item.id);
            const ClassIcon = getClassCardIcon(item.id);
            const bookLabel = getClassBookLabel(item.name);
            const bookNumber = getClassNumber(item.name);

            return (
             <div
                key={item.id}
                className="group overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm ring-1 ring-transparent transition-all duration-300 hover:-translate-y-1 hover:border-[#b9cfe3] hover:shadow-xl hover:ring-[#dce7f1]"
              >
                {/* Header */}
                <div className={`relative overflow-hidden bg-gradient-to-br ${theme.gradient} py-3 pl-4 pr-4 text-white sm:pr-36`}>

                  {/* Ambient glow */}
                  <div className={`pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full ${theme.glow1} blur-2xl`} />
                  <div className={`pointer-events-none absolute -bottom-12 left-10 h-28 w-28 rounded-full ${theme.glow2} blur-2xl`} />

                  {/* Decorative book graphic — dropped below sm so the class name
                      always has the full card width to itself. */}
                  <div className="hidden sm:block">
                    <ClassBookBadge
                      label={bookLabel}
                      number={bookNumber}
                      bookGradient={theme.bookGradient}
                      numberColor={theme.numberColor}
                    />
                  </div>

                  <div className="relative flex items-start gap-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10 shadow-inner backdrop-blur">
                      <ClassIcon className={`h-4 w-4 ${theme.iconColor}`} />
                    </div>

                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h3 className="break-words text-sm font-bold leading-tight tracking-tight text-white sm:truncate">
                          {item.name}
                        </h3>

                        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border ${theme.badgeBorder} ${theme.badgeBg} px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${theme.badgeText}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${theme.badgeDot}`} />
                          Active
                        </span>
                      </div>

                      <div className={`mt-1 flex items-center gap-1 text-[11px] font-medium ${theme.metaText}`}>
                        <Layers3 size={10} />
                        General
                      </div>
                    </div>
                  </div>

                  <div className="relative mt-2 flex flex-wrap items-center justify-between gap-1 border-t border-white/10 pt-2">
                    <span className={`text-[10px] ${theme.metaText}`}>
                      Created {new Date(item.createdAt).toLocaleDateString()}
                    </span>

                    {item.startDate && new Date(item.startDate).getTime() > Date.now() && (
                      <div className={`inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] font-semibold ${theme.badgeText} backdrop-blur`}>
                        <CalendarDays size={11} />
                        Upcoming: {new Date(item.startDate).toLocaleDateString("en-GB", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* Body */}
                <div className="space-y-3 p-4">

                  {/* Two columns: Details / Schedule */}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">

                  {/* Left: Details */}
                  <div className="space-y-1.5">

                    <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 p-2 transition-colors group-hover:border-[#8fb0cd]">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#eef3f8] text-[#32598A]">
                        <Users size={13} />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                          Students
                        </p>
                        <p className="break-words text-sm font-bold text-slate-900 sm:truncate">
                          {item.students.filter((entry) => entry.isActive).length}
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => void openFeeHistory(item)}
                      title="View fee change history"
                      className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 p-2 text-left transition-colors hover:border-[#8fb0cd] hover:bg-[#eef3f8]/50 group-hover:border-[#8fb0cd]"
                    >
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#dce7f1] text-[#264867]">
                        <Wallet size={13} />
                      </div>
                      <div className="min-w-0">
                        <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                          Fee
                          <History size={9} className="text-[#5b85ac]" />
                        </p>
                        <p className="break-words text-sm font-bold text-slate-900 sm:truncate">
                          Rs. {item.monthlyFee.toLocaleString()}
                        </p>
                      </div>
                    </button>

                    <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 p-2 transition-colors group-hover:border-[#8fb0cd]">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#dce7f1] text-[#264867]">
                        <Calendar size={13} />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                          Due Week
                        </p>
                        <p className="break-words text-sm font-bold text-slate-900 sm:truncate">
                          Week {item.paymentDueWeek}
                        </p>
                      </div>
                    </div>

                  </div>

                  {/* Right: Schedule */}
                  <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">

                    <div className="mb-2 flex items-center gap-1.5">
                      <div className="flex h-5 w-5 items-center justify-center rounded-md bg-[#1a3049]/10">
                        <CalendarDays className="h-3 w-3 text-[#1a3049]" />
                      </div>

                      <span className="text-xs font-semibold text-slate-800">
                        Weekly Schedule
                      </span>
                    </div>

                    {item.schedules?.length > 0 ? (
                      <div className="space-y-1.5">
                        {item.schedules.slice(0, 2).map((schedule) => (
                          <div
                            key={`${schedule.dayOfWeek}-${schedule.startTime}`}
                            className="flex items-center justify-between rounded-md border border-slate-100 bg-white px-2 py-1.5 shadow-sm"
                          >
                            <span className="rounded-md bg-[#eef3f8] px-1.5 py-0.5 text-[10px] font-semibold text-[#264867]">
                              {schedule.dayOfWeek}
                            </span>

                            <span className="flex items-center gap-1 text-[10px] font-medium text-slate-500">
                              <Clock size={10} className="text-[#5b85ac]" />
                              {formatTime12h(schedule.startTime)}
                              {" - "}
                              {formatTime12h(schedule.endTime)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500">
                        Schedule not available
                      </p>
                    )}

                  </div>

                  </div>

                  {/* Description */}
                  <div className="flex items-start gap-1.5">
                    <FileText size={12} className="mt-0.5 shrink-0 text-slate-400" />
                    <p className="line-clamp-2 text-xs leading-5 text-slate-600">
                      {item.description ||
                        "No class description provided."}
                    </p>
                  </div>

                  {/* Footer */}
                  <div className="grid grid-cols-3 gap-1.5 border-t border-slate-100 pt-3">

                    <button
                      onClick={() => setStudentsPanelClassId(item.id)}
                      className="flex items-center justify-center gap-1 rounded-lg bg-gradient-to-r from-[#32598A] to-[#1a3049] py-1.5 text-[10px] font-semibold text-white shadow-sm transition hover:shadow-md hover:brightness-110"
                    >
                      <Users size={11} />
                      Students
                    </button>

                    <button
                      onClick={() => beginEdit(item)}
                      className="flex items-center justify-center gap-1 rounded-lg border border-slate-200 py-1.5 text-[10px] font-medium text-slate-700 transition hover:bg-slate-50"
                    >
                      <Pencil size={11} />
                      Edit
                    </button>

                    <button
                      onClick={() => void deleteClass(item.id)}
                      className="flex items-center justify-center gap-1 rounded-lg border border-rose-200 bg-rose-50 py-1.5 text-[10px] font-medium text-rose-600 transition hover:bg-rose-100"
                    >
                      <Trash2 size={11} />
                      Delete
                    </button>

                  </div>

                </div>
              </div>

            );
          })}
        </div>
        ) : null}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">
            Showing {items.length > 0 ? (page - 1) * PAGE_SIZE + 1 : 0} to {(page - 1) * PAGE_SIZE + items.length} of {totalItems} classes
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1 || isLoading}
              onClick={() => void loadClasses(page - 1)}
              className="btn-ghost"
            >
              Previous
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                type="button"
                disabled={isLoading}
                onClick={() => void loadClasses(p)}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-sm font-semibold transition-colors ${
                  p === page
                    ? "bg-[#264867] text-white"
                    : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                {p}
              </button>
            ))}
            <button
              type="button"
              disabled={page >= totalPages || isLoading}
              onClick={() => void loadClasses(page + 1)}
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
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col overflow-hidden border-l border-[#dce7f1] bg-white/95 shadow-panel backdrop-blur-lg transition-transform duration-300 ${
          isCreatePanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >

        <div className="shrink-0 border-b border-border bg-background/95 px-5 py-3 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#32598A] to-[#1a3049] text-white shadow-md">
                <GraduationCap size={18} />
              </div>

              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold tracking-tight text-foreground">
                    Create New Class
                  </h3>

                  <span className="rounded-full border border-[#b9cfe3] bg-[#eef3f8] px-2 py-0.5 text-[10px] font-medium text-[#264867]">
                    Setup
                  </span>
                </div>

                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  Configure class information, payment settings and weekly schedules.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsCreatePanelOpen(false)}
              className="inline-flex h-8 shrink-0 items-center rounded-lg border border-border bg-background px-3 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              Close
            </button>
          </div>
        </div>

        <form className="flex-1 space-y-4 overflow-y-auto px-5 py-4" onSubmit={handleCreate}>

                {/* {errorMessage ? (

                <p className="notice-error mt-6">{errorMessage}</p>
              ) : null} */}

              {errorMessage && (
                <div className="fixed inset-x-5 bottom-5 z-[100] sm:inset-x-auto sm:right-5">
                  <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-white p-4 shadow-xl sm:min-w-[320px]">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100">
                      <AlertTriangle size={18} className="text-red-600" />
                    </div>

                    <div className="flex-1">
                      <p className="text-sm font-semibold text-slate-900">
                        Something went wrong
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
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="mb-3 flex items-center gap-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#eef3f8] text-[#264867]">
                <BookOpen size={13} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Basic Information
                </h3>
                <p className="text-xs text-muted-foreground">
                  Configure the core details of your class.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label htmlFor="className" className="form-label mb-1.5 block">
                  Class name
                </label>
                <div className="relative">
                  <BookOpen size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
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
                    className="control-input pl-8 text-sm"
                    placeholder="Math - Grade 7"
                  />
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label htmlFor="classMonthlyFee" className="form-label mb-1.5 block">
                    Monthly fee (LKR)
                  </label>
                  <div className="relative">
                    <Wallet size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
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
                      className="control-input pl-8 text-sm"
                      placeholder="2500"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="classPaymentDueWeek" className="form-label mb-1.5 block">
                    Payment due week
                  </label>
                  <div className="relative">
                    <Calendar size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
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
                      className="control-select h-9 pl-8 text-sm"
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
          </div>

          {/* Schedule Section */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">

            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#eef3f8] text-[#264867]">
                  <CalendarDays size={13} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    Class Schedules
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Configure weekly class sessions.
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  setCreateForm((prev) => ({
                    ...prev,
                    schedules: [...prev.schedules, getDefaultScheduleRow()],
                  }));
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-[#b9cfe3] bg-[#eef3f8] px-2.5 py-1 text-[11px] font-semibold text-[#264867] transition hover:bg-[#dce7f1]"
              >
                <Plus size={12} />
                Add Schedule
              </button>

            </div>

            {/* Batch Start Date */}
            <div className="mb-4 grid gap-3 md:grid-cols-2">
              <div>
                <label className="form-label mb-1.5 block">
                  Batch Start Date
                </label>

                <div className="relative">
                  <CalendarDays size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="date"
                    value={createForm.startDate}
                    onChange={(e) =>
                      setCreateForm((prev) => ({
                        ...prev,
                        startDate: e.target.value,
                      }))
                    }
                    className="control-input pl-8 text-sm"
                  />
                </div>

                <p className="mt-1 text-[11px] text-slate-500">
                  Date when this batch begins.
                </p>
              </div>

              <div>
                <label className="form-label mb-1.5 block">
                  Preview
                </label>

                <div className="flex h-9 items-center rounded-lg border border-slate-200 bg-slate-50 px-2.5">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                      createForm.startDate &&
                      new Date(createForm.startDate) > new Date()
                        ? "bg-amber-100 text-amber-700"
                        : "bg-[#dce7f1] text-[#264867]"
                    }`}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                    {createForm.startDate &&
                    new Date(createForm.startDate) > new Date()
                      ? "Upcoming Batch"
                      : "Running Batch"}
                  </span>
                </div>
              </div>
            </div>

            <div className="space-y-2.5">
              {createForm.schedules.map((schedule, index) => (
                <div
                  key={`${schedule.dayOfWeek}-${index}`}
                  className="rounded-lg border border-border/70 bg-muted/20 p-3 transition-all hover:border-[#b9cfe3]"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold text-foreground">
                        Schedule {index + 1}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
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
                      <Trash2 size={12} />
                      Remove
                    </button>
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">

                    <div>
                      <label className="form-label mb-1.5 block">
                        Day of week
                      </label>

                      <div className="relative">
                        <Calendar size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
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
                          className="control-select h-9 pl-8 text-sm"
                        >
                          {WEEK_DAYS.map((day) => (
                            <option key={day} value={day}>
                              {day}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="form-label mb-1.5 block">
                        Start time
                      </label>

                      <div className="relative">
                        <Clock size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
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
                          className="control-input pl-8 text-sm"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="form-label mb-1.5 block">
                        End time
                      </label>

                      <div className="relative">
                        <Clock size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
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
                          className="control-input pl-8 text-sm"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Additional Information */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="mb-3 flex items-center gap-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#eef3f8] text-[#264867]">
                <FileText size={13} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Additional Information
                </h3>
                <p className="text-xs text-muted-foreground">
                  Optional details about the class.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label htmlFor="classScheduleSummary" className="form-label mb-1.5 block">
                  Schedule summary
                </label>

                <div className="relative">
                  <CalendarDays size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    id="classScheduleSummary"
                    value={createForm.schedules
                      .map(
                        (row) =>
                          `${getDayShortLabel(row.dayOfWeek)} ${row.startTime}-${row.endTime}`
                      )
                      .join(" | ")}
                    readOnly
                    className="control-input cursor-not-allowed bg-slate-50 pl-8 text-sm text-slate-500"
                    placeholder="Auto-generated from schedule rows"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="classDescription" className="form-label mb-1.5 block">
                  Description
                </label>

                <div className="relative">
                  <FileText size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-slate-400" />
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
                    className="control-textarea pl-8 text-sm"
                    placeholder="Weekly class focus and outcomes"
                  />
                </div>
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={isSaving}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[#32598A] to-[#1a3049] py-2 text-sm font-semibold text-white shadow-sm transition hover:shadow-md hover:brightness-110 disabled:pointer-events-none disabled:opacity-60"
          >
            <GraduationCap size={15} />
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
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col overflow-hidden border-l border-[#dce7f1] bg-white/95 shadow-panel backdrop-blur-lg transition-transform duration-300 ${
          isEditPanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="shrink-0 border-b border-[#b9cfe3] bg-white/90 px-5 py-3 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#dce7f1] text-[#264867]">
                <Pencil size={16} />
              </span>
              <div>
                <h3 className="text-base font-semibold">Edit class</h3>
                <p className="mt-0.5 text-xs text-muted">Update class details and schedules.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => { setIsEditPanelOpen(false); setEditingId(null); }}
              className="btn-ghost shrink-0"
            >
              Close
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div className="space-y-1.5 rounded-xl border border-border bg-card p-3 shadow-sm">
            <label htmlFor="editClassName" className="form-label mb-1 block">
              Class name
            </label>
            <input
              id="editClassName"
              required
              value={editForm.name}
              onChange={(event) => setEditForm((prev) => ({ ...prev, name: event.target.value }))}
              className="control-input text-sm"
              placeholder="Math - Grade 7"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-card p-3 shadow-sm sm:grid-cols-2">
            <div>
              <label htmlFor="editMonthlyFee" className="form-label mb-1 block">
                Monthly fee (LKR)
              </label>
              <input
                id="editMonthlyFee"
                type="number"
                min="0"
                required
                value={editForm.monthlyFee}
                onChange={(event) => setEditForm((prev) => ({ ...prev, monthlyFee: event.target.value }))}
                className="control-input text-sm"
                placeholder="2500"
              />
            </div>
            <div>
              <label htmlFor="editPaymentDueWeek" className="form-label mb-1 block">
                Payment due week
              </label>
              <select
                id="editPaymentDueWeek"
                value={editForm.paymentDueWeek}
                onChange={(event) => setEditForm((prev) => ({ ...prev, paymentDueWeek: event.target.value }))}
                className="control-select h-9 text-sm"
              >
                <option value="1">First week</option>
                <option value="2">Second week</option>
                <option value="3">Third week</option>
                <option value="4">Fourth week</option>
              </select>
            </div>
          </div>

          <div className="space-y-2 rounded-xl border border-border bg-card p-3 shadow-sm">
            <label className="form-label mb-1 block">Class schedules</label>
            <div className="space-y-2">
              {editForm.schedules.map((schedule, index) => (
                <div key={`${schedule.dayOfWeek}-${index}`} className="rounded-lg border border-border/70 bg-muted/20 p-3">
                  <div>
                    <label className="form-label mb-1 block">Day of week</label>
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
                      className="control-select h-9 text-sm"
                    >
                      {WEEK_DAYS.map((day) => (
                        <option key={day} value={day}>{day}</option>
                      ))}
                    </select>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <div>
                      <label className="form-label mb-1 block">Start time</label>
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
                        className="control-input text-sm"
                      />
                    </div>
                    <div>
                      <label className="form-label mb-1 block">End time</label>
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
                        className="control-input text-sm"
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
                      <Trash2 size={12} />
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setEditForm((prev) => ({ ...prev, schedules: [...prev.schedules, getDefaultScheduleRow()] }))}
              className="btn-secondary mt-1"
            >
              <Plus size={12} />
              Add schedule row
            </button>
          </div>

          <div className="space-y-1.5 rounded-xl border border-border bg-card p-3 shadow-sm">
            <label className="form-label mb-1 block">Schedule summary</label>
            <input
              value={editForm.schedules.map((row) => `${getDayShortLabel(row.dayOfWeek)} ${row.startTime}-${row.endTime}`).join(" | ")}
              readOnly
              className="control-input cursor-not-allowed bg-slate-50 text-sm text-slate-500"
            />
          </div>

          <div className="space-y-1.5 rounded-xl border border-border bg-card p-3 shadow-sm">
            <label htmlFor="editDescription" className="form-label mb-1 block">
              Description
            </label>
            <textarea
              id="editDescription"
              rows={4}
              value={editForm.description}
              onChange={(event) => setEditForm((prev) => ({ ...prev, description: event.target.value }))}
              className="control-textarea text-sm"
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
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col overflow-hidden border-l border-[#dce7f1] bg-white/95 shadow-panel backdrop-blur-lg transition-transform duration-300 ${
          studentsPanelClassId ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="shrink-0 border-b border-slate-200 bg-white/90 px-5 py-3 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                <Users size={16} />
              </span>
              <div>
                <h3 className="text-base font-semibold text-slate-900">Students</h3>
                <p className="mt-0.5 text-xs text-slate-500">{studentsPanelClass?.name ?? "Class"}</p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={openAddStudents}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#32598A] px-3 text-xs font-semibold text-white hover:bg-[#264867]"
              >
                <UserPlus size={13} />
                Add Students
              </button>

              <button
                type="button"
                onClick={() => setStudentsPanelClassId(null)}
                className="inline-flex h-8 items-center rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {/* Overview */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Overview</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                <CheckSquare2 size={11} />
                Active {studentsPanelActiveStudents.length}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-gray-600">
                <Clock size={11} />
                Past {studentsPanelPastStudents.length}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-[#b9cfe3] bg-[#eef3f8] px-2.5 py-1 text-[11px] font-semibold text-[#264867]">
                <Users size={11} />
                Total {studentsPanelClass?.students.length ?? 0}
              </span>
            </div>
          </div>

          {/* Active Students */}
          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                <CheckSquare2 size={12} className="text-emerald-600" />
                Active students ({studentsPanelActiveStudents.length})
              </p>
            </div>
            {studentsPanelActiveStudents.length === 0 ? (
              <div className="px-5 py-6 text-center">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-gray-100">
                  <Users size={14} className="text-muted" />
                </span>
                <p className="mt-2 text-xs font-semibold text-foreground">No active students</p>
                <p className="text-xs text-muted">Add students using the button above.</p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-50">
                {studentsPanelActiveStudents.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-slate-50"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#eef3f8] text-[11px] font-semibold text-[#264867]">
                        {entry.student.name.slice(0, 2).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <p className="break-words text-xs font-semibold text-foreground sm:truncate">{entry.student.name}</p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          {entry.student.registrationNumber ? (
                            <span className="text-[11px] text-muted">{entry.student.registrationNumber}</span>
                          ) : null}
                          {formatGrade(entry.student.grade?.GradeDesc) ? (
                            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                              {formatGrade(entry.student.grade?.GradeDesc)}
                            </span>
                          ) : null}
                          <span className="flex items-center gap-1 text-[11px] text-muted">
                            <Calendar size={10} />
                            {formatStoredSriLankaDate(entry.assignedAt)}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Link
                        href={`/dashboard/students/${entry.student.id}`}
                        className="inline-flex items-center justify-center rounded-md border border-slate-200 p-1.5 text-slate-600 transition-colors hover:bg-slate-50 hover:text-[#264867]"
                        title="View Student Profile"
                      >
                        <Eye size={13} />
                      </Link>

                      <button
                        type="button"
                        onClick={() =>
                          setRemovingEntry({
                            studentId: entry.student.id,
                            name: entry.student.name,
                          })
                        }
                        className="inline-flex items-center gap-1 rounded-md border border-rose-200 px-2 py-1 text-[11px] font-medium text-rose-600 transition-colors hover:bg-rose-50"
                      >
                        <UserMinus size={11} />
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
            <div className="border-b border-gray-100 px-4 py-2.5">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                <Clock size={12} className="text-gray-400" />
                Past students ({studentsPanelPastStudents.length})
              </p>
            </div>
            {studentsPanelPastStudents.length === 0 ? (
              <p className="px-4 py-4 text-xs text-muted">No past student records yet.</p>
            ) : (
              <ul className="divide-y divide-gray-50">
                {studentsPanelPastStudents.map((entry) => (
                  <li key={entry.id} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-bold text-gray-500">
                        {entry.student.name.slice(0, 2).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="break-words text-xs font-semibold text-foreground sm:truncate">{entry.student.name}</p>
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600">
                            <UserMinus size={9} />
                            Removed
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          {entry.student.registrationNumber ? (
                            <span className="text-[11px] text-muted">{entry.student.registrationNumber}</span>
                          ) : null}
                          {formatGrade(entry.student.grade?.GradeDesc) ? (
                            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                              {formatGrade(entry.student.grade?.GradeDesc)}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-1 space-y-0.5">
                          <p className="flex items-center gap-1.5 text-[11px] text-muted">
                            <Calendar size={10} className="text-emerald-500" />
                            <span className="font-medium text-gray-500">Joined</span>
                            {formatStoredSriLankaDateTime(entry.assignedAt)}
                          </p>
                          <p className="flex items-center gap-1.5 text-[11px] text-muted">
                            <Clock size={10} className="text-rose-500" />
                            <span className="font-medium text-rose-500">Removed</span>
                            {entry.removedAt ? formatStoredSriLankaDateTime(entry.removedAt) : "—"}
                          </p>
                          {entry.removeReason ? (
                            <p className="flex items-start gap-1.5 text-[11px] text-muted">
                              <FileText size={10} className="mt-0.5 shrink-0 text-gray-400" />
                              <span className="font-medium text-gray-500">Reason:</span>
                              <span className="italic">{entry.removeReason}</span>
                            </p>
                          ) : null}
                        </div>
                      </div>

                      <Link
                        href={`/dashboard/students/${entry.student.id}`}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:border-[#8fb0cd] hover:bg-[#eef3f8] hover:text-[#264867]"
                        title="View Student Profile"
                      >
                        <ExternalLink size={13} />
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
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col overflow-hidden border-l border-[#dce7f1] bg-white/95 shadow-panel backdrop-blur-lg transition-transform duration-300 ${
          isAddStudentsOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Panel header */}
        <div className="shrink-0 border-b border-[#b9cfe3] bg-white/90 px-5 py-3 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#dce7f1] text-[#264867]">
                <UserPlus size={16} />
              </span>
              <div>
                <h3 className="text-base font-semibold">Add students</h3>
                <p className="mt-0.5 text-xs text-muted">{studentsPanelClass?.name}</p>
              </div>
            </div>
            <button type="button" onClick={() => setIsAddStudentsOpen(false)} className="btn-ghost shrink-0">
              Close
            </button>
          </div>
        </div>

        {/* Sort toolbar */}
        <div className="shrink-0 border-b border-slate-100 bg-white px-5 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="shrink-0 rounded-md bg-[#eef3f8] px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#264867]">
              Sort By
            </span>

            <button
              type="button"
              onClick={() => handleSort("Name")}
              className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                sortBy === "Name"
                  ? "bg-[#264867] text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              Name
              {sortBy === "Name" &&
                (sortOrder === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
            </button>

            <button
              type="button"
              onClick={() => handleSort("RegistrationNumber")}
              className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                sortBy === "RegistrationNumber"
                  ? "bg-[#264867] text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              Registration #
              {sortBy === "RegistrationNumber" &&
                (sortOrder === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
            </button>

            <button
              type="button"
              onClick={() => handleSort("CreatedAt")}
              className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                sortBy === "CreatedAt"
                  ? "bg-[#264867] text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              Date Added
              {sortBy === "CreatedAt" &&
                (sortOrder === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
            </button>
          </div>
        </div>

        {/* Student list */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {isLoadingAvailableStudents ? (
            <div className="flex items-center justify-center py-16">
              <p className="text-xs text-muted">Loading students...</p>
            </div>
          ) : (
            <>
              <div className="mb-2.5 flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5">
                <label className="flex shrink-0 cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={isAllSelected}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setSelectedStudentIds((prev) => {
                        const next = new Set(prev);
                        if (checked) {
                          selectableStudents.forEach((student) => next.add(student.id));
                        } else {
                          selectableStudents.forEach((student) => next.delete(student.id));
                        }
                        return next;
                      });
                    }}
                  />
                  <span className="text-xs font-medium">Select All</span>
                </label>

                <div className="flex shrink-0 items-center gap-2">
                  {selectedStudentIds.size > 0 && (
                    <span className="text-[11px] font-semibold text-[#264867]">
                      {selectedStudentIds.size} selected
                    </span>
                  )}

                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setIsFilterOpen((prev) => !prev)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
                    >
                      <Search size={12} />
                      Filters
                    </button>

                    {isFilterOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setIsFilterOpen(false)} />

                        <div className="absolute right-0 top-8 z-50 w-[min(320px,calc(100vw-2.5rem))] rounded-xl border border-slate-200 bg-white shadow-2xl">
                          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
                            <div>
                              <h3 className="text-xs font-semibold">Filter Students</h3>
                              <p className="mt-0.5 text-[11px] text-slate-500">Search students for this class</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => setIsFilterOpen(false)}
                              className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
                            >
                              <X size={14} />
                            </button>
                          </div>

                          <div className="space-y-3 p-4">
                            <div>
                              <label className="mb-1 block text-[11px] font-medium text-slate-500">Registration Number</label>
                              <input
                                className="control-input w-full text-sm"
                                placeholder="Registration Number"
                                value={filters.registrationNumber}
                                onChange={(e) => setFilters((prev) => ({ ...prev, registrationNumber: e.target.value }))}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    loadStudentList(1, filters);
                                    setIsFilterOpen(false);
                                  }
                                }}
                              />
                            </div>

                            <div>
                              <label className="mb-1 block text-[11px] font-medium text-slate-500">Student Name</label>
                              <input
                                className="control-input w-full text-sm"
                                placeholder="Student Name"
                                value={filters.name}
                                onChange={(e) => setFilters((prev) => ({ ...prev, name: e.target.value }))}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    loadStudentList(1, filters);
                                    setIsFilterOpen(false);
                                  }
                                }}
                              />
                            </div>

                            <div>
                              <label className="mb-1 block text-[11px] font-medium text-slate-500">Email</label>
                              <input
                                className="control-input w-full text-sm"
                                placeholder="Email"
                                value={filters.email}
                                onChange={(e) => setFilters((prev) => ({ ...prev, email: e.target.value }))}
                              />
                            </div>

                            <div>
                              <label className="mb-1 block text-[11px] font-medium text-slate-500">Grade</label>
                              <select
                                value={filters.grade}
                                onChange={(e) => setFilters((prev) => ({ ...prev, grade: e.target.value }))}
                                className="control-select h-9 w-full text-sm"
                              >
                                <option value="">All Grades</option>
                                {grades.map((grade) => (
                                  <option key={grade.id} value={grade.id}>
                                    {grade.GradeDesc.replace("GRADE_0", "Grade ").replace("GRADE_", "Grade ")}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>

                          <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-2.5">
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => {
                                const reset = { registrationNumber: "", name: "", email: "", grade: filters.grade };
                                setFilters(reset);
                                loadStudentList(1, reset);
                                setIsFilterOpen(false);
                              }}
                            >
                              Reset
                            </button>
                            <button
                              type="button"
                              className="btn-primary"
                              onClick={() => {
                                loadStudentList(1, filters);
                                setIsFilterOpen(false);
                              }}
                            >
                              Search
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  <span className="shrink-0 text-[11px] text-slate-500">{selectableStudents.length} students</span>
                </div>
              </div>

              {availableStudents.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#dce7f1] text-[#264867]">
                    <Users size={20} />
                  </div>
                  <h3 className="mt-3 text-sm font-semibold text-foreground">
                    {hasStudentFilter ? "No matching students" : "No Students Available"}
                  </h3>
                  <p className="mt-1.5 max-w-sm text-xs leading-5 text-muted-foreground">
                    {hasStudentFilter
                      ? "No students match your current search. Adjust the filters above and try again."
                      : "There are no students available to assign to this class. Create a student first and then return here to enroll them."}
                  </p>
                  {hasStudentFilter ? (
                    <button
                      type="button"
                      onClick={() => {
                        const reset = { registrationNumber: "", name: "", email: "", grade: "" };
                        setFilters(reset);
                        void loadStudentList(1, reset);
                      }}
                      className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                    >
                      <RotateCcw size={13} />
                      Clear filters
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => router.push("/dashboard/students")}
                      className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                    >
                      <RotateCcw size={13} />
                      Go to Students
                    </button>
                  )}
                </div>
              ) : (
                <ul className="divide-y divide-gray-100">
              {sortedAvailableStudents.map((student) => {
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
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left transition-colors ${
                        isEnrolled
                          ? "cursor-default opacity-50"
                          : isSelected
                          ? "bg-[#eef3f8]"
                          : "hover:bg-gray-50"
                      }`}
                    >
                      <span className={`shrink-0 ${isEnrolled ? "text-gray-300" : isSelected ? "text-[#32598A]" : "text-gray-300"}`}>
                        {isSelected ? <CheckSquare2 size={16} /> : <Square size={16} />}
                      </span>
                      <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                        isEnrolled ? "bg-gray-100 text-gray-400" : "bg-[#dce7f1] text-[#264867]"
                      }`}>
                        {student.name.slice(0, 2).toUpperCase()}
                      </span>

                      <div className="min-w-0 flex-1">
                        <p className="break-words text-xs font-semibold text-foreground sm:truncate">{student.name}</p>
                        <div className="flex flex-wrap items-center gap-x-2">
                          {student.registrationNumber ? (
                            <span className="text-[11px] text-muted">{student.registrationNumber}</span>
                          ) : null}
                          {student.grade ? (
                            <span className="text-[11px] text-muted">
                              {student.grade.GradeDesc.replace("GRADE_0", "Grade ").replace("GRADE_", "Grade ")}
                            </span>
                          ) : null}
                          {student.status === 0 ? (
                            <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-700">
                              Active
                            </span>
                          ) : (
                            <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                              Inactive
                            </span>
                          )}
                        </div>
                      </div>

                      {isEnrolled && (
                        <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                          Enrolled
                        </span>
                      )}
                      {student.status !== 0 && (
                        <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                          Inactive
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
                </ul>
              )}
            </>
          )}
        </div>

        {/* Pagination */}
        <div className="flex shrink-0 flex-col gap-2.5 border-t border-slate-100 bg-white px-5 py-2.5 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2.5">
            <div className="relative">
              <select
                value={pageSize}
                onChange={(e) => {
                  const size = Number(e.target.value);
                  setPageSize(size);
                  void loadStudentList(1, filters, sortBy, sortOrder, size);
                }}
                className="appearance-none rounded-lg border border-slate-200 bg-white py-1.5 pl-2.5 pr-7 text-xs font-medium text-slate-700 shadow-sm transition hover:border-[#8fb0cd] focus:border-[#3d6690] focus:outline-none"
              >
                <option value={5}>5 / Page</option>
                <option value={10}>10 / Page</option>
                <option value={20}>20 / Page</option>
                <option value={50}>50 / Page</option>
                <option value={100}>100 / Page</option>
              </select>
              <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
            </div>

            <span className="hidden text-xs text-slate-500 sm:block">
              Page <strong>{studentPage}</strong> of <strong>{studentTotalPages}</strong>
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              disabled={studentPage === 1 || isLoadingList}
              onClick={() => void loadStudentList(1, filters)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronsLeft size={14} />
            </button>
            <button
              disabled={studentPage === 1 || isLoadingList}
              onClick={() => void loadStudentList(studentPage - 1, filters)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft size={14} />
            </button>

            <div className="max-w-[220px] overflow-x-auto scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent">
              <div className="flex gap-1.5 px-0.5">
                {Array.from({ length: studentTotalPages }, (_, i) => i + 1).map((p) => (
                  <button
                    key={p}
                    onClick={() => void loadStudentList(p, filters)}
                    disabled={isLoadingList}
                    className={`flex h-8 min-w-[32px] items-center justify-center rounded-lg border text-xs font-semibold transition-all duration-200 ${
                      p === studentPage
                        ? "border-[#264867] bg-[#264867] text-white shadow"
                        : "border-slate-200 bg-white text-slate-600 hover:border-[#8fb0cd] hover:bg-[#eef3f8]"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            <button
              disabled={studentPage === studentTotalPages || isLoadingList}
              onClick={() => void loadStudentList(studentPage + 1, filters)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight size={14} />
            </button>
            <button
              disabled={studentPage === studentTotalPages || isLoadingList}
              onClick={() => void loadStudentList(studentTotalPages, filters)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronsRight size={14} />
            </button>
          </div>
        </div>

        {/* Footer actions */}
        <div className="shrink-0 border-t border-[#b9cfe3] bg-white px-5 py-3">
          <div className="flex gap-2.5">
            <button type="button" onClick={() => setIsAddStudentsOpen(false)} className="btn-ghost flex-1">
              Cancel
            </button>
            <button
              type="button"
              disabled={selectedStudentIds.size === 0 || isAssigning}
              onClick={() => void handleAssignStudents()}
              className="btn-primary flex-1 gap-1.5"
            >
              <UserPlus size={13} />
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

      {feeHistoryClass && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6"
          onClick={() => setFeeHistoryClass(null)}
        >
          <div
            className="w-full max-w-md rounded-3xl border border-[#b9cfe3] bg-white p-6 shadow-panel"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-[#dce7f1] text-[#264867]">
                  <History size={18} />
                </span>
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Fee history</h2>
                  <p className="text-xs text-muted">{feeHistoryClass.name}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setFeeHistoryClass(null)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-50"
              >
                <X size={14} />
              </button>
            </div>

            {isFeeHistoryLoading ? (
              <p className="py-6 text-center text-sm text-muted">Loading history...</p>
            ) : feeHistory.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">No fee history recorded.</p>
            ) : (
              <ol className="space-y-2.5">
                {feeHistory.map((entry) => (
                  <li
                    key={entry.id}
                    className={`rounded-xl border p-3 ${
                      entry.isCurrent
                        ? "border-[#b9cfe3] bg-[#eef3f8]/60"
                        : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-base font-bold text-slate-900">
                        Rs. {entry.amount.toLocaleString()}
                      </span>
                      {entry.isCurrent ? (
                        <span className="rounded-full bg-[#32598A] px-2 py-0.5 text-[10px] font-semibold text-white">
                          Current
                        </span>
                      ) : (
                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                          Past
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">
                      From {formatStoredSriLankaDateTime(entry.effectiveFrom)}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {entry.effectiveTo
                        ? `Until ${formatStoredSriLankaDateTime(entry.effectiveTo)}`
                        : "Still in effect"}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}

      {isHelpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6">
          <div className="w-full max-w-3xl rounded-3xl border border-[#b9cfe3] bg-white/95 p-6 shadow-panel backdrop-blur">
            <div className="mb-5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-[#dce7f1] text-[#264867]">
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
