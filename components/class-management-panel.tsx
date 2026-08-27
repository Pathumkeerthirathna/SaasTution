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

function hashString(value: string) {
  let hash = 0;

  for (let i = 0; i < value.length; i++) {
    hash = value.charCodeAt(i) + ((hash << 5) - hash);
  }

  return Math.abs(hash);
}

const CLASS_CARD_THEMES = [
  {
    gradient: "from-blue-700 via-blue-800 to-indigo-900",
    glow1: "bg-blue-300/20",
    glow2: "bg-sky-400/10",
    iconColor: "text-blue-200",
    metaText: "text-blue-200/80",
    badgeBorder: "border-blue-300/30",
    badgeBg: "bg-blue-400/15",
    badgeDot: "bg-blue-300",
    badgeText: "text-blue-50",
    bookGradient: "from-blue-400 to-blue-700",
    numberColor: "text-blue-300",
  },
  {
    gradient: "from-emerald-600 via-green-700 to-teal-800",
    glow1: "bg-emerald-300/20",
    glow2: "bg-teal-400/10",
    iconColor: "text-emerald-200",
    metaText: "text-emerald-200/80",
    badgeBorder: "border-emerald-300/30",
    badgeBg: "bg-emerald-400/15",
    badgeDot: "bg-emerald-300",
    badgeText: "text-emerald-50",
    bookGradient: "from-emerald-400 to-green-700",
    numberColor: "text-emerald-300",
  },
  {
    gradient: "from-violet-600 via-purple-700 to-fuchsia-800",
    glow1: "bg-violet-300/20",
    glow2: "bg-fuchsia-400/10",
    iconColor: "text-violet-200",
    metaText: "text-violet-200/80",
    badgeBorder: "border-violet-300/30",
    badgeBg: "bg-violet-400/15",
    badgeDot: "bg-violet-300",
    badgeText: "text-violet-50",
    bookGradient: "from-violet-400 to-purple-700",
    numberColor: "text-violet-300",
  },
  {
    gradient: "from-orange-600 via-amber-700 to-orange-800",
    glow1: "bg-amber-200/25",
    glow2: "bg-orange-300/10",
    iconColor: "text-amber-100",
    metaText: "text-amber-100/80",
    badgeBorder: "border-amber-200/30",
    badgeBg: "bg-amber-300/20",
    badgeDot: "bg-amber-200",
    badgeText: "text-amber-50",
    bookGradient: "from-amber-300 to-orange-600",
    numberColor: "text-amber-200",
  },
  {
    gradient: "from-rose-600 via-pink-700 to-rose-800",
    glow1: "bg-rose-300/20",
    glow2: "bg-pink-400/10",
    iconColor: "text-rose-200",
    metaText: "text-rose-200/80",
    badgeBorder: "border-rose-300/30",
    badgeBg: "bg-rose-400/15",
    badgeDot: "bg-rose-300",
    badgeText: "text-rose-50",
    bookGradient: "from-rose-400 to-pink-700",
    numberColor: "text-rose-300",
  },
  {
    gradient: "from-sky-700 via-cyan-700 to-teal-800",
    glow1: "bg-teal-300/20",
    glow2: "bg-sky-400/10",
    iconColor: "text-teal-200",
    metaText: "text-sky-200/80",
    badgeBorder: "border-teal-300/30",
    badgeBg: "bg-teal-400/15",
    badgeDot: "bg-teal-300",
    badgeText: "text-teal-50",
    bookGradient: "from-teal-400 to-blue-800",
    numberColor: "text-cyan-200",
  },
] as const;

const CLASS_CARD_ICONS = [
  Sigma,
  Compass,
  FlaskConical,
  Atom,
  Calculator,
  Microscope,
  BookOpen,
  Pencil,
];

export function getClassCardTheme(classId: string) {
  return CLASS_CARD_THEMES[
    hashString(classId) % CLASS_CARD_THEMES.length
  ];
}

export function getClassCardIcon(classId: string) {
  return CLASS_CARD_ICONS[
    hashString(`${classId}-icon`) % CLASS_CARD_ICONS.length
  ];
}

export function getClassBookLabel(name: string) {
  const firstPart = name.split(/[-–—]/)[0]?.trim() || name.trim();
  const firstWord = firstPart.split(/\s+/)[0] || firstPart;
  return firstWord.slice(0, 8).toUpperCase();
}

export function getClassNumber(name: string) {
  const digits = name.match(/\d+/g);

  if (digits && digits.length > 0) {
    return String(Number(digits[digits.length - 1]));
  }

  return getClassBookLabel(name).charAt(0);
}

export function ClassBookBadge({
  label,
  number,
  bookGradient,
  numberColor,
}: {
  label: string;
  number: string;
  bookGradient: string;
  numberColor: string;
}) {
  return (
    <div className="pointer-events-none absolute right-6 top-1/2 h-24 w-28 -translate-y-1/2">

      {/* Decorative sparkle dots */}
      <span className="absolute right-2 top-0.5 h-1 w-1 rounded-full bg-white/50" />
      <span className="absolute right-7 top-2.5 h-1 w-1 rounded-full bg-white/30" />
      <span className="absolute right-4 top-4 h-0.5 w-0.5 rounded-full bg-white/40" />

      {/* Bold numeral, sitting behind the book */}
      <span className={`absolute right-2 top-1/2 -translate-y-1/2 select-none text-5xl font-black leading-none drop-shadow-sm ${numberColor}`}>
        {number}
      </span>

      {/* Book */}
      <div className="absolute left-2 top-1 h-20 w-[60px] rotate-[8deg]">

        {/* Page edges */}
        <div className="absolute inset-y-1 -right-1 w-2.5 rounded-r-sm bg-slate-100 shadow-sm" />
        <div className="absolute inset-y-1.5 -right-0.5 w-2 rounded-r-sm bg-white" />

        {/* Cover */}
        <div
          className={`relative flex h-full w-full items-center justify-center rounded-md bg-gradient-to-br ${bookGradient} shadow-xl ring-1 ring-black/10`}
        >
          {/* Spine shadow */}
          <div className="absolute inset-y-0 left-0 w-2.5 rounded-l-md bg-black/20" />

          {/* Glossy highlight */}
          <div className="absolute inset-x-2.5 top-1.5 h-1/3 rounded-full bg-white/15 blur-[2px]" />

          <span className="relative px-1 text-center text-[11px] font-extrabold uppercase leading-tight tracking-wide text-white drop-shadow">
            {label}
          </span>
        </div>
      </div>

      {/* Pencil */}
      <div className="absolute left-0 bottom-2 h-20 w-2.5 rotate-[40deg]">
        {/* Shaft */}
        <div className="absolute bottom-0 h-[72%] w-full rounded-sm bg-gradient-to-b from-orange-400 to-orange-500 shadow-md" />

        {/* Metal band */}
        <div className="absolute bottom-[72%] h-1.5 w-full bg-slate-300" />

        {/* Wood taper */}
        <div
          className="absolute bottom-[calc(72%+6px)] h-3 w-full bg-amber-200"
          style={{ clipPath: "polygon(0% 0%, 100% 0%, 65% 100%, 35% 100%)" }}
        />

        {/* Graphite tip */}
        <div
          className="absolute bottom-[calc(72%+18px)] h-1.5 w-full bg-slate-700"
          style={{ clipPath: "polygon(35% 0%, 65% 0%, 50% 100%)" }}
        />
      </div>

    </div>
  );
}

type GradeItem = {
  id: number;
  GradeDesc: string;
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
      <div className="bg-slate-200 py-3 pl-4 pr-36">
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

      // if (appliedFilters.schedule.trim()) {
      //   query.set("schedule", appliedFilters.schedule.trim());
      // }

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
  void loadClasses(1, {
    registrationNumber: "",
    name: "",
    email: "",
    grade: "",
  });
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
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-green-600 text-white">
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
                  <div className="flex items-center gap-1 text-emerald-600">
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
                  <div className="flex items-center gap-1 text-green-600">
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
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-600"
                >
                  <BookOpen size={13} />
                  New Class
                </button>

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
                className="group overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm ring-1 ring-transparent transition-all duration-300 hover:-translate-y-1 hover:border-teal-200 hover:shadow-xl hover:ring-teal-100"
              >
                {/* Header */}
                <div className={`relative overflow-hidden bg-gradient-to-br ${theme.gradient} py-3 pl-4 pr-36 text-white`}>

                  {/* Ambient glow */}
                  <div className={`pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full ${theme.glow1} blur-2xl`} />
                  <div className={`pointer-events-none absolute -bottom-12 left-10 h-28 w-28 rounded-full ${theme.glow2} blur-2xl`} />

                  <ClassBookBadge
                    label={bookLabel}
                    number={bookNumber}
                    bookGradient={theme.bookGradient}
                    numberColor={theme.numberColor}
                  />

                  <div className="relative flex items-start gap-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10 shadow-inner backdrop-blur">
                      <ClassIcon className={`h-4 w-4 ${theme.iconColor}`} />
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <h3 className="truncate text-sm font-bold leading-tight tracking-tight text-white">
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

                  <div className="relative mt-2 flex items-center justify-between border-t border-white/10 pt-2">
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

                    <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 p-2 transition-colors group-hover:border-sky-200">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-100 text-sky-600">
                        <Users size={13} />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                          Students
                        </p>
                        <p className="truncate text-sm font-bold text-slate-900">
                          {overview.activeStudents}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 p-2 transition-colors group-hover:border-teal-200">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-teal-100 text-teal-700">
                        <Wallet size={13} />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                          Fee
                        </p>
                        <p className="truncate text-sm font-bold text-slate-900">
                          Rs. {item.monthlyFee.toLocaleString()}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 p-2 transition-colors group-hover:border-blue-200">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-blue-100 text-blue-700">
                        <Calendar size={13} />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                          Due Week
                        </p>
                        <p className="truncate text-sm font-bold text-slate-900">
                          Week {item.paymentDueWeek}
                        </p>
                      </div>
                    </div>

                  </div>

                  {/* Right: Schedule */}
                  <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">

                    <div className="mb-2 flex items-center gap-1.5">
                      <div className="flex h-5 w-5 items-center justify-center rounded-md bg-blue-900/10">
                        <CalendarDays className="h-3 w-3 text-blue-900" />
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
                            <span className="rounded-md bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
                              {schedule.dayOfWeek}
                            </span>

                            <span className="flex items-center gap-1 text-[10px] font-medium text-slate-500">
                              <Clock size={10} className="text-teal-600" />
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
                      className="flex items-center justify-center gap-1 rounded-lg bg-gradient-to-r from-blue-900 to-teal-600 py-1.5 text-[10px] font-semibold text-white shadow-sm transition hover:shadow-md hover:brightness-110"
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
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col overflow-hidden border-l border-brand-100 bg-white/95 shadow-panel backdrop-blur-lg transition-transform duration-300 ${
          isCreatePanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >

        <div className="shrink-0 border-b border-border bg-background/95 px-5 py-3 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-900 to-teal-600 text-white shadow-md">
                <GraduationCap size={18} />
              </div>

              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold tracking-tight text-foreground">
                    Create New Class
                  </h3>

                  <span className="rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-[10px] font-medium text-teal-700">
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
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="mb-3 flex items-center gap-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
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
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
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
                className="inline-flex items-center gap-1 rounded-lg border border-teal-200 bg-teal-50 px-2.5 py-1 text-[11px] font-semibold text-teal-700 transition hover:bg-teal-100"
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
                        : "bg-teal-100 text-teal-700"
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
                  className="rounded-lg border border-border/70 bg-muted/20 p-3 transition-all hover:border-teal-200"
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
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-700">
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
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-900 to-teal-600 py-2 text-sm font-semibold text-white shadow-sm transition hover:shadow-md hover:brightness-110 disabled:pointer-events-none disabled:opacity-60"
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
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col overflow-hidden border-l border-brand-100 bg-white/95 shadow-panel backdrop-blur-lg transition-transform duration-300 ${
          isEditPanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="shrink-0 border-b border-brand-200 bg-white/90 px-5 py-3 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-100 text-brand-700">
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
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col overflow-hidden border-l border-brand-100 bg-white/95 shadow-panel backdrop-blur-lg transition-transform duration-300 ${
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
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white hover:bg-brand-700"
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
              <span className="inline-flex items-center gap-1.5 rounded-md border border-brand-200 bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-700">
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
                      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-blue-50 text-[11px] font-semibold text-blue-700">
                        {entry.student.name.slice(0, 2).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-foreground">{entry.student.name}</p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          {entry.student.registrationNumber ? (
                            <span className="text-[11px] text-muted">{entry.student.registrationNumber}</span>
                          ) : null}
                          <span className="flex items-center gap-1 text-[11px] text-muted">
                            <Calendar size={10} />
                            {new Date(entry.assignedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Link
                        href={`/dashboard/students/${entry.student.id}`}
                        className="inline-flex items-center justify-center rounded-md border border-slate-200 p-1.5 text-slate-600 transition-colors hover:bg-slate-50 hover:text-brand-700"
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
                          <p className="truncate text-xs font-semibold text-foreground">{entry.student.name}</p>
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600">
                            <UserMinus size={9} />
                            Removed
                          </span>
                        </div>
                        {entry.student.registrationNumber ? (
                          <p className="text-[11px] text-muted">{entry.student.registrationNumber}</p>
                        ) : null}
                        <div className="mt-1 space-y-0.5">
                          <p className="flex items-center gap-1.5 text-[11px] text-muted">
                            <Calendar size={10} className="text-emerald-500" />
                            <span className="font-medium text-gray-500">Joined</span>
                            {new Date(entry.assignedAt).toLocaleString("en-GB", {
                              day: "2-digit", month: "short", year: "numeric",
                              hour: "2-digit", minute: "2-digit",
                            })}
                          </p>
                          <p className="flex items-center gap-1.5 text-[11px] text-muted">
                            <Clock size={10} className="text-rose-500" />
                            <span className="font-medium text-rose-500">Removed</span>
                            {entry.removedAt
                              ? new Date(entry.removedAt).toLocaleString("en-GB", {
                                  day: "2-digit", month: "short", year: "numeric",
                                  hour: "2-digit", minute: "2-digit",
                                })
                              : "—"}
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
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
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
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col overflow-hidden border-l border-brand-100 bg-white/95 shadow-panel backdrop-blur-lg transition-transform duration-300 ${
          isAddStudentsOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Panel header */}
        <div className="shrink-0 border-b border-brand-200 bg-white/90 px-5 py-3 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-100 text-brand-700">
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
          <div className="flex items-center gap-1.5 overflow-x-auto">
            <span className="shrink-0 rounded-md bg-brand-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-brand-700">
              Sort By
            </span>

            <button
              type="button"
              onClick={() => handleSort("Name")}
              className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                sortBy === "Name"
                  ? "bg-brand-700 text-white shadow-sm"
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
                  ? "bg-brand-700 text-white shadow-sm"
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
                  ? "bg-brand-700 text-white shadow-sm"
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
          ) : availableStudents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-100 text-brand-700">
                <Users size={20} />
              </div>
              <h3 className="mt-3 text-sm font-semibold text-foreground">No Students Available</h3>
              <p className="mt-1.5 max-w-sm text-xs leading-5 text-muted-foreground">
                There are no students available to assign to this class.
                Create a student first and then return here to enroll them.
              </p>
              <button
                type="button"
                onClick={() => router.push("/dashboard/students")}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
              >
                <RotateCcw size={13} />
                Go to Students
              </button>
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
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
                    <span className="text-[11px] font-semibold text-brand-700">
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

                        <div className="absolute right-0 top-8 z-50 w-[320px] rounded-xl border border-slate-200 bg-white shadow-2xl">
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
                          ? "bg-brand-50"
                          : "hover:bg-gray-50"
                      }`}
                    >
                      <span className={`shrink-0 ${isEnrolled ? "text-gray-300" : isSelected ? "text-brand-600" : "text-gray-300"}`}>
                        {isSelected ? <CheckSquare2 size={16} /> : <Square size={16} />}
                      </span>
                      <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                        isEnrolled ? "bg-gray-100 text-gray-400" : "bg-brand-100 text-brand-700"
                      }`}>
                        {student.name.slice(0, 2).toUpperCase()}
                      </span>

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-foreground">{student.name}</p>
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
                className="appearance-none rounded-lg border border-slate-200 bg-white py-1.5 pl-2.5 pr-7 text-xs font-medium text-slate-700 shadow-sm transition hover:border-brand-300 focus:border-brand-500 focus:outline-none"
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
                        ? "border-brand-700 bg-brand-700 text-white shadow"
                        : "border-slate-200 bg-white text-slate-600 hover:border-brand-300 hover:bg-brand-50"
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
        <div className="shrink-0 border-t border-brand-200 bg-white px-5 py-3">
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
