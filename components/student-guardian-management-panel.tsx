"use client";

import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  FormEvent,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Ban,
  BookOpen,
  CalendarDays,
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
  CircleHelp,
  Download,
  FileSpreadsheet,
  GraduationCap,
  Hash,
  Loader2,
  Mail,
  Pencil,
  Phone,
  PhoneCall,
  Plus,
  Search,
  Trash2,
  Upload,
  User,
  Users,
  X,
  XCircle,
} from "lucide-react";

// import * as XLSX from "xlsx";
// import { saveAs } from "file-saver";
import { Grade, StudentConfirmationStatus } from "@prisma/client";

import ExcelJS from "exceljs";
import { saveAs } from "file-saver";
import toast from "react-hot-toast";
import { email } from "zod";

export type StudentListItem = {
  id: string;
  name: string;
  status: number;
  deactivationReason: string | null;
  grade: Grade | null;
  contact01: string | null;
  contact02: string | null;
  email: string | null;
  registrationNumber: string | null;
  StudentRegistrationSource:string;
  StudentConfirmationStatus:string;
  classes: {
    id: string;
    name: string;
  }[];
  createdAt: string;
};

type ApiError = {
  message?: string;
};

export type PaginatedStudentsResponse = {
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

type ImportStudentRow = {
  registrationNumber: string;
  studentName: string;
  grade: string;
  gradeId: number | null;
  primaryContact: string;
  secondaryContact: string;
  email: string;
};


function formatGradeLabel(value: string | null) {
  if (!value) {
    return "-";
  }

  return value.startsWith("GRADE_") ? `Grade ${value.slice(6)}` : value;
}

function getPaginationRange(
  current: number,
  total: number
): (number | "ellipsis")[] {
  if (total <= 1) {
    return total === 1 ? [1] : [];
  }

  const range: (number | "ellipsis")[] = [1];

  const left = Math.max(2, current - 1);
  const right = Math.min(total - 1, current + 1);

  if (left > 2) {
    range.push("ellipsis");
  }

  for (let page = left; page <= right; page++) {
    range.push(page);
  }

  if (right < total - 1) {
    range.push("ellipsis");
  }

  range.push(total);

  return range;
}

function formatRegisteredDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// A single navy-blue tone (matching the app's confirmed brand palette) is
// used for every avatar instead of a per-student rainbow rotation, so the
// student list reads consistently with the rest of the blue-branded UI.
const AVATAR_COLORS = ["bg-[#32598A]"];

function getStudentAvatarColor(seed: string) {
  let hash = 0;

  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }

  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function StudentGuardianManagementPanel() {

  const router = useRouter();

  const [pageSize, setPageSize] = useState(5);

  const [isCheckingRegistrationNumber, setIsCheckingRegistrationNumber] =
  useState(false);
  
  const [isCheckingEmail, setIsCheckinEmail] =
  useState(false);
  
  const [isCheckingName, setIsCheckingName] =
  useState(false);

  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);

  const [filterAnchorRect, setFilterAnchorRect] = useState<DOMRect | null>(
    null
  );

  const [isEditPanelOpen, setIsEditPanelOpen] = useState(false);

  const [editStudentForm, setEditStudentForm] = useState({
    id: "",
    registrationNumber: "",
    name: "",
    gradeId: null as number | null,
    contact01: "",
    contact02: "",
    email: "",
  });

  const registrationSourceClasses = {
  MANUAL:
    "border-blue-200 bg-blue-50 text-blue-700",
  EXCEL_IMPORT:
    "border-violet-200 bg-violet-50 text-violet-700",
  ONLINE:
    "border-cyan-200 bg-cyan-50 text-cyan-700",
};

  const [students, setStudents] = useState<StudentListItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [filters, setFilters] = useState({
    name: "",
    grade: "",
    email: "",
    registrationNumber: "",
  });

  const [statusFilter, setStatusFilter] = useState({
    active: false,
    inactive: false,
  });

  const [sortBy, setSortBy] = useState("CreatedAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  const [isConfirmingAll, setIsConfirmingAll] = useState(false);

  const [pendingAction, setPendingAction] = useState<{
    type: "delete" | "activate";
    studentId: string;
    rect: DOMRect;
  } | null>(null);

  const [deactivateStudentId, setDeactivateStudentId] = useState<string | null>(
    null
  );
  const [deactivateReason, setDeactivateReason] = useState("");
  const [isDeactivating, setIsDeactivating] = useState(false);

  function askActivateStudent(
    event: ReactMouseEvent<HTMLButtonElement>,
    studentId: string
  ) {
    setPendingAction({
      type: "activate",
      studentId,
      rect: event.currentTarget.getBoundingClientRect(),
    });
  }

  function askDeleteStudent(
    event: ReactMouseEvent<HTMLButtonElement>,
    studentId: string
  ) {
    setPendingAction({
      type: "delete",
      studentId,
      rect: event.currentTarget.getBoundingClientRect(),
    });
  }

  function askDeactivateStudent(
    _event: ReactMouseEvent<HTMLButtonElement>,
    studentId: string
  ) {
    setDeactivateReason("");
    setDeactivateStudentId(studentId);
  }

  function askEditDeactivationReason(
    studentId: string,
    currentReason: string | null
  ) {
    setDeactivateReason(currentReason ?? "");
    setDeactivateStudentId(studentId);
  }

    const loadRegistrationNumber = useCallback(async () => {
      const response = await fetch(
        "/api/student/next-registration-number"
      );

      const data = await response.json();

      setStudentForm((prev) => ({
        ...prev,
        registrationNumber: data.registrationNumber,
      }));
    }, []);

    function handleEditStudent(student: StudentListItem) {
      //setOpenActionMenu(null);

      setEditStudentForm({
        id: student.id,
        registrationNumber: student.registrationNumber ?? "",
        name: student.name,
        gradeId: student.grade?.id ?? null,
        contact01: student.contact01 ?? "",
        contact02: student.contact02 ?? "",
        email: student.email ?? "",
      });

      setIsEditPanelOpen(true);
    }

    async function handleUpdateStudent(
      event: FormEvent<HTMLFormElement>
    ) {
      event.preventDefault();

      if (isSubmitting) return;

      if (registrationNumberError || EmailError || NameError) {
        toast.error("Please fix the highlighted fields before saving.");
        return;
      }

      setIsSubmitting(true);

      try {
        const response = await fetch(
          `/api/students/${editStudentForm.id}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              registrationNumber: editStudentForm.registrationNumber,
              name: editStudentForm.name,
              gradeId: editStudentForm.gradeId,
              contact01: editStudentForm.contact01,
              contact02: editStudentForm.contact02,
              email: editStudentForm.email,
            }),
          }
        );

        const payload = await response.json();

        if (!response.ok || !payload.success) {
          toast.error(
            payload.error?.message ??
            "Failed to update student."
          );
          return;
        }

        toast.success("Student updated successfully.");
        
        setStudents((prev) =>
          prev.map((student) =>
            student.id === editStudentForm.id
              ? {
                  ...student,
                  registrationNumber: editStudentForm.registrationNumber,
                  name: editStudentForm.name,
                  contact01: editStudentForm.contact01,
                  contact02: editStudentForm.contact02,
                  email: editStudentForm.email,
                  grade: grades.find(
                    (g) => g.id === editStudentForm.gradeId
                  ) ?? student.grade,
                }
              : student
          )
        );

        setTimeout(() => {
          setIsEditPanelOpen(false);
        }, 800);

      } catch {

        toast.error("Unable to update student right now.");

      } finally {
        setIsSubmitting(false);
      }
    }

    async function handleActivateStudent(studentId: string) {
      try {
        const response = await fetch(
          `/api/students/${studentId}/activate`,
          {
            method: "PUT",
          }
        );

        const payload = await response.json();

        if (!response.ok || !payload.success) {
          toast.error(
            payload.error?.message ?? "Failed to activate student."
          );
          return;
        }

        toast.success("Student activated successfully.",{duration:5000});

        //setOpenActionMenu(null);

        await loadStudentList(page, filters);
      } catch {
        toast.error("Unable to activate student.");
      }
    }

    async function handleDeactivateStudent(
      studentId: string,
      reason: string,
      isReasonEdit = false
    ) {
      setIsDeactivating(true);
      try {
        const response = await fetch(
          `/api/students/${studentId}/deactivate`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason }),
          }
        );

        const payload = await response.json();

        if (!response.ok || !payload.success) {
          toast.error(
            payload.error?.message ??
              (isReasonEdit
                ? "Failed to update reason."
                : "Failed to deactivate student.")
          );
          return;
        }

        toast.success(isReasonEdit ? "Reason updated." : "Student deactivated.");
        setDeactivateStudentId(null);
        setDeactivateReason("");
        await loadStudentList(page, filters);
      } catch {
        toast.error("Unable to deactivate student.");
      } finally {
        setIsDeactivating(false);
      }
    }

    async function handleDeleteStudent(studentId: string) {
      try {
        const response = await fetch(
          `/api/students/${studentId}`,
          {
            method: "DELETE",
          }
        );

        const payload = await response.json();

        if (!response.ok || !payload.success) {
          toast.error(
            payload.error?.message ?? "Failed to delete student."
          );
          return;
        }

        toast.success("Student deleted successfully.");

        //setOpenActionMenu(null);

        await loadStudentList(page, filters);
      } catch {
        toast.error("Unable to delete student.");
      }
    }

  // const actionMenuRef = useRef<HTMLDivElement>(null);

  const [isLoadingList, setIsLoadingList] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [isAddPanelOpen, setIsAddPanelOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [totalItems, setTotalItems] = useState(0);
  const [studentForm, setStudentForm] = useState({
    name: "",
    registrationNumber: "",
    gradeId: null as number | null,
    contact01: "",
    contact02: "",
    email: "",
  });

  //const [openActionMenu, setOpenActionMenu] = useState<string | null>(null);

  const hasStudents = useMemo(() => students.length > 0, [students]);

  const pendingStudents = useMemo(
  () =>
    students.filter(
      (s) => s.StudentConfirmationStatus === "PENDING"
    ),
  [students]
);

const pendingCount = pendingStudents.length;

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

  function toggleActiveStatusFilter(checked: boolean) {
    const next = { ...statusFilter, active: checked };

    setStatusFilter(next);

    void loadStudentList(
      1,
      filters,
      sortBy,
      sortOrder,
      pageSize,
      next
    );
  }

  function toggleInactiveStatusFilter(checked: boolean) {
    const next = { ...statusFilter, inactive: checked };

    setStatusFilter(next);

    void loadStudentList(
      1,
      filters,
      sortBy,
      sortOrder,
      pageSize,
      next
    );
  }

  const loadStudentList = useCallback(
    async (
      nextPage = 1,
      appliedFilters = { name: "", grade: "", email: "", registrationNumber: "" },
      currentSortBy = sortBy,
      currentSortOrder = sortOrder,
      currentPageSize = pageSize,
      currentStatusFilter = statusFilter
    ) => {
        setIsLoadingList(true);

        try {
          const query = new URLSearchParams({
            page: String(nextPage),
            pageSize: String(currentPageSize),
          });

          query.set("sortBy", currentSortBy);
          query.set("sortOrder", currentSortOrder);

          if (appliedFilters.name.trim()) {
            query.set("name", appliedFilters.name.trim());
          }

          if (appliedFilters.grade) {
            query.set("grade", appliedFilters.grade);
          }

          if (appliedFilters.email.trim()) {
            query.set("email", appliedFilters.email.trim());
          }

          if (appliedFilters.registrationNumber.trim()) {
            query.set(
              "registrationNumber",
              appliedFilters.registrationNumber.trim()
            );
          }

          if (
            currentStatusFilter.active &&
            !currentStatusFilter.inactive
          ) {
            query.set("status", "0");
          } else if (
            currentStatusFilter.inactive &&
            !currentStatusFilter.active
          ) {
            query.set("status", "1");
          }

          console.log(
            `/api/students?${query.toString()}`
          );

          const response = await fetch(
            `/api/students?${query.toString()}`
          );

          const payload =
            (await response.json()) as PaginatedStudentsResponse;

          if (!response.ok || !payload.success) {
            toast.error(
              payload.error?.message ??
                "Failed to load students."
            );
            return;
          }

          console.log(payload);

          setStudents(payload.data ?? []);
          setPage(payload.pagination?.page ?? nextPage);
          setTotalPages(
            payload.pagination?.totalPages ?? 1
          );
          setTotalItems(
            payload.pagination?.totalItems ?? 0
          );
        } catch {
          toast.error(
            "Unable to load students right now."
          );
        } finally {
          setIsLoadingList(false);
        }
      },
      [sortBy, sortOrder, statusFilter]
    );

  const [grades, setGrades] = useState<Grade[]>([]);

  const [isImportPreviewOpen, setIsImportPreviewOpen] = useState(false);

  const [importStudents, setImportStudents] = useState<ImportStudentRow[]>([]);

  const [previewPage, setPreviewPage] = useState(1);

  const [isImporting, setIsImporting] = useState(false);

  const [importErrors, setImportErrors] = useState<
  {
      row: number;
      field: string;
      message: string;
    }[]
  >([]);


   const IMPORT_PREVIEW_PAGE_SIZE = 10;

  const totalPreviewPages = Math.ceil(
    importStudents.length / IMPORT_PREVIEW_PAGE_SIZE
  );

  const paginatedStudents = importStudents.slice(
    (previewPage - 1) * IMPORT_PREVIEW_PAGE_SIZE,
    previewPage * IMPORT_PREVIEW_PAGE_SIZE
  );

  function updateImportStudent(
    globalIndex: number,
    patch: Partial<ImportStudentRow>
  ) {
    setImportStudents((prev) =>
      prev.map((row, i) => (i === globalIndex ? { ...row, ...patch } : row))
    );
  }

  function removeImportStudent(globalIndex: number) {
    setImportStudents((prev) => prev.filter((_, i) => i !== globalIndex));
    setPreviewPage((prev) => {
      const nextTotal = Math.max(
        1,
        Math.ceil((importStudents.length - 1) / IMPORT_PREVIEW_PAGE_SIZE)
      );
      return Math.min(prev, nextTotal);
    });
  }

  const loadGrades = useCallback(async () => {
    try {
      const response = await fetch("/api/Grade");

      if (!response.ok) {
        throw new Error();
      }

      const data = await response.json();

      console.log("Loaded grades:", data);

      setGrades(data);
    } catch {
      console.error("Failed to load grades");
    }
  }, []);

  useEffect(() => {

    void loadStudentList(1, { name: "", grade: "", email: "", registrationNumber: "" });
    void loadGrades();
    void loadRegistrationNumber();

      function handleClickOutside(event: MouseEvent) {
          const target = event.target as HTMLElement;

          if (!target.closest("[data-action-menu]")) {
           // setOpenActionMenu(null);
          }
        }

        document.addEventListener("mousedown", handleClickOutside);

        return () => {
          document.removeEventListener(
            "mousedown",
            handleClickOutside
          );
      };

  document.addEventListener("mousedown", handleClickOutside);

  return () => {
    document.removeEventListener(
      "mousedown",
      handleClickOutside
    );
  };

  }, [loadStudentList,loadGrades,loadRegistrationNumber]);

 
 async function downloadTemplate() {
    // The grade dropdown needs the grade list. Fall back to a fresh fetch in
    // case the initial load has not finished (or returned nothing) yet.
    let gradeList = grades;
    if (gradeList.length === 0) {
      try {
        const response = await fetch("/api/Grade");
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data)) gradeList = data as Grade[];
        }
      } catch {
        // ignore; handled by the guard below
      }
    }

    if (gradeList.length === 0) {
      alert(
        "No grades are configured yet. Add grades before downloading the import template."
      );
      return;
    }

    const workbook = new ExcelJS.Workbook();

    // ==========================
    // Grades Sheet (Master Data) — created first so the dropdown can point at it
    // ==========================
    const gradesSheet = workbook.addWorksheet("Grades");
    gradesSheet.columns = [
      { header: "GradeId", key: "gradeId", width: 15 },
      { header: "GradeName", key: "gradeName", width: 25 },
    ];
    gradeList.forEach((grade) => {
      gradesSheet.addRow({ gradeId: grade.id, gradeName: grade.GradeDesc });
    });
    gradesSheet.state = "hidden";

    const lastGradeRow = gradeList.length + 1;

    // ExcelJS data validation does not reliably resolve cross-sheet range
    // references, but it does resolve workbook-level defined names.
    workbook.definedNames.add(
      `Grades!$B$2:$B$${lastGradeRow}`,
      "GradeNameList"
    );

    // ==========================
    // Students Sheet
    // ==========================
    const studentSheet = workbook.addWorksheet("Students");

    studentSheet.columns = [
      { header: "RegistrationNo", key: "registrationNo", width: 20 },
      { header: "StudentName", key: "studentName", width: 30 },
      { header: "Grade", key: "grade", width: 20 },
      { header: "GradeId", key: "gradeId", width: 15 },
      { header: "PrimaryContact", key: "primaryContact", width: 20 },
      { header: "SecondaryContact", key: "secondaryContact", width: 20 },
      { header: "Email", key: "email", width: 30 },
    ];

    // Sample row
    studentSheet.addRow([
      "REG00001",
      "Nethmi Perera",
      "",
      "",
      "0771234567",
      "0711234567",
      "nethmi@gmail.com",
    ]);

    // Apply dropdowns + formulas for first 500 rows
    for (let row = 2; row <= 500; row++) {
      // Grade dropdown (Column C) — reads from the GradeNameList defined name
      studentSheet.getCell(`C${row}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: ["GradeNameList"],
        showErrorMessage: true,
        errorTitle: "Invalid Grade",
        error: "Please select a grade from the dropdown",
      };

      // Auto GradeId (Column D)
      studentSheet.getCell(`D${row}`).value = {
        formula: `IFERROR(INDEX(Grades!$A$2:$A$${lastGradeRow},MATCH(C${row},GradeNameList,0)),"")`,
      };

      // Make GradeId readonly
      studentSheet.getCell(`D${row}`).protection = { locked: true };
    }

    // ==========================
    // Unlock editable columns
    // ==========================
    ["A", "B", "C", "E", "F", "G"].forEach((col) => {
      for (let row = 2; row <= 500; row++) {
        studentSheet.getCell(`${col}${row}`).protection = { locked: false };
      }
    });

    // ==========================
    // Header styling
    // ==========================
    const headerRow = studentSheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.height = 22;

    // Freeze header row
    studentSheet.views = [{ state: "frozen", ySplit: 1 }];

    // Protect sheet
    await studentSheet.protect("student-template", {
      selectLockedCells: true,
      selectUnlockedCells: true,
    });

    // ==========================
    // Download file
    // ==========================
    const buffer = await workbook.xlsx.writeBuffer();

    saveAs(
      new Blob([buffer as ArrayBuffer]),
      "StudentTemplate.xlsx"
    );
 }

  async function handleExcelUpload(
  event: React.ChangeEvent<HTMLInputElement>
  ) {
  const file = event.target.files?.[0];

  if (!file) {
  return;
  }

  try {
    const workbook = new ExcelJS.Workbook();


    await workbook.xlsx.load(
      await file.arrayBuffer()
    );

    const worksheet = workbook.getWorksheet("Students");

    if (!worksheet) {
      alert("Students sheet not found.");
      return;
    }

    const rows: ImportStudentRow[] = [];

    worksheet.eachRow((row, rowNumber) => {
      // Skip header row
      if (rowNumber === 1) return;

      // Skip completely empty rows
      const registrationNumber = row.getCell(1).value;
      const studentName = row.getCell(2).value;

      if (!registrationNumber && !studentName) {
        return;
      }

      // console.log(row.getCell(4).result);
      // return;

      rows.push({
        registrationNumber:
          row.getCell(1).value?.toString() ?? "",

        studentName:
          row.getCell(2).value?.toString() ?? "",

        grade:
          row.getCell(3).value?.toString() ?? "",

        gradeId:
          Number(row.getCell(4).result) || null,

        primaryContact:
          row.getCell(5).value?.toString() ?? "",

        secondaryContact:
          row.getCell(6).value?.toString() ?? "",

        email:
          row.getCell(7).value?.toString() ?? "",
      });
    });

    setImportErrors([]);

    setImportStudents(rows);
    setPreviewPage(1);
    setIsImportPreviewOpen(true);


    } catch (error) {
    console.error(error);
    alert("Failed to read Excel file.");
    } finally {
    // Allow uploading same file again
    event.target.value = "";
    }
  }

  async function handleConfirmImport() {
    setIsImporting(true);
    

    try {
      const response = await fetch(
        "/api/students/import",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({registrationSource: "IMPORT",students: importStudents}),
        }
      );

      const result = await response.json();

      if (!response.ok) {
        setImportErrors(result.errors ?? []);
        return;
      }

      if (result.success) {
        setImportErrors([]);

        setIsImportPreviewOpen(false);

        setImportStudents([]);
        setPreviewPage(1);

        await loadStudentList(page, filters);

        toast.success(
          `${result.count} students imported successfully.`
        );
      }
    } catch (error) {
      console.error(error);

      setImportErrors([
        {
          row: 0,
          field: "system",
          message: "Failed to import students.",
        },
      ]);
    } finally {
      setIsImporting(false);
    }
  }

  async function downloadStudents() {
    const query = new URLSearchParams();

    if (filters.name.trim()) {
      query.set("name", filters.name.trim());
    }

    if (filters.grade) {
      query.set("grade", filters.grade);
    }

    if (filters.email.trim()) {
      query.set("email", filters.email.trim());
    }

    query.set("sortBy", sortBy);
    query.set("sortOrder", sortOrder);

    window.location.href =
      `/api/students/export?${query.toString()}`;
  }

  async function handleCreateStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting) return;

    if (registrationNumberError || EmailError || NameError) {
      toast.error("Please fix the highlighted fields before saving.");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/students", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({...studentForm,registrationSource: "TEACHER",}),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: ApiError;
      };

      if (!response.ok || !payload.success) {
        toast.error(payload.error?.message ?? "Failed to add student.");
        return;
      }

      setStudentForm({
        registrationNumber:"",
        name: "",
        gradeId: 0,
        contact01: "",
        contact02: "",
        email: "",
      });

      await loadRegistrationNumber();

      toast.success("Student added successfully.");
      await loadStudentList(1, filters);
      setIsAddPanelOpen(false);
    } catch {
      toast.error("Unable to add student right now.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const [registrationNumberError, setRegistrationNumberError] = useState("");
  const [EmailError, setEmailError] = useState("");
  const [NameError, setNameError] = useState("");

  const checkRegistrationNumber = async (
    registrationNumber: string,
    selectedStudentId: string
  ) => {
    const regNo = registrationNumber.trim();

    if (!regNo) {
      setRegistrationNumberError("");
      return;
    }

    try {

      setIsCheckingRegistrationNumber(true);

      const response = await fetch(`/api/students/check-registration-number?registrationNumber=${encodeURIComponent(regNo)}&studentId=${selectedStudentId}`
      );

      const result = await response.json();

      if (result.exists) {
        setRegistrationNumberError("Registration number already exists.");
      } else {
        setRegistrationNumberError("");
      }
    } catch (error) {
      console.error(error);
    } finally {
      setIsCheckingRegistrationNumber(false);
    }
  };

  const checkEmail = async (
    registrationNumber: string,
    selectedStudentId: string
  ) => {
    const regNo = registrationNumber.trim();

    if (!regNo) {
      setEmailError("");
      return;
    }

    try {

      setIsCheckinEmail(true);

      const response = await fetch(`/api/students/check-email?registrationNumber=${encodeURIComponent(regNo)}&studentId=${selectedStudentId}`
      );

      const result = await response.json();

      if (result.exists) {
        setEmailError("Email already exists.");
      } else {
        setEmailError("");
      }
    } catch (error) {
      console.error(error);
    } finally {
      setIsCheckinEmail(false);
    }
  };

  const checkName = async (
    name: string,
    selectedStudentId: string,
    gradeId: number | null | undefined
  ) => {
    const value = name.trim();

    // Only meaningful once a grade is chosen — a name clash is per grade.
    if (!value || !gradeId) {
      setNameError("");
      return;
    }

    try {
      setIsCheckingName(true);

      const response = await fetch(
        `/api/students/check-name?registrationNumber=${encodeURIComponent(
          value
        )}&studentId=${selectedStudentId}&gradeId=${gradeId}`
      );

      const result = await response.json();

      setNameError(
        result.exists
          ? "A student with this name already exists in this grade."
          : ""
      );
    } catch (error) {
      console.error(error);
    } finally {
      setIsCheckingName(false);
    }
  };

  // Only the actual field errors gate the submit button. The "checking…"
  // flags must NOT disable it — an onBlur check fired by the button click
  // itself would otherwise swallow that first click.
  const hasValidationErrors =
  !!registrationNumberError ||
  !!EmailError ||
  !!NameError;

 const handleConfirmStudent = async (student: StudentListItem) => {

  console.log(student);

  try {
    const response = await fetch(`/api/students/${student.id}/confirm`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const result = await response.json();

    console.log(result);

    if (!response.ok) {
      throw new Error(result.message || "Failed to confirm student.");
    }

    toast.success("Student confirmed successfully.");

    setStudents((prev) =>
      prev.map((s) =>
        s.id === student.id
          ? {
              ...s,
              StudentConfirmationStatus: StudentConfirmationStatus.APPROVED,
            }
          : s
      )
    );
  } catch (error) {
    console.error(error);

    toast.error(
      error instanceof Error
        ? error.message
        : "Failed to confirm student."
    );

    if (error instanceof Error) {
      console.error(error.message);
      console.error(error.stack);
    } else {
      console.error(error);
    }
  }
};

 const handleDeclineStudent = async (student: StudentListItem) => {

  console.log(student);

  try {
    const response = await fetch(`/api/students/${student.id}/decline`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const result = await response.json();

    console.log(result);

    if (!response.ok) {
      throw new Error(result.message || "Failed to confirm student.");
    }

    toast.error("Student declined successfully.");

    setStudents((prev) =>
      prev.map((s) =>
        s.id === student.id
          ? {
              ...s,
              StudentConfirmationStatus: StudentConfirmationStatus.REJECTED,
            }
          : s
      )
    );
  } catch (error) {
    console.error(error);

    toast.error(
      error instanceof Error
        ? error.message
        : "Failed to confirm student."
    );

    if (error instanceof Error) {
      console.error(error.message);
      console.error(error.stack);
    } else {
      console.error(error);
    }
  }
};

const handleConfirmAllStudents = async () => {
  if (!confirm(`Confirm all ${pendingCount} pending students?`)) {
    return;
  }

  setIsConfirmingAll(true);

  try {
    const response = await fetch("/api/students/confirm-all", {
      method: "PUT",
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message);
    }

    toast.success(`${pendingCount} students confirmed successfully.`);

    await loadStudentList(page, filters);
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : "Failed to confirm students."
    );
  }
};

  return (
    <section>
      <article className="flex max-h-[calc(100vh-110px)] flex-col gap-4 overflow-hidden rounded-xl border border-slate-200 bg-white px-4 pb-4 pt-4 shadow-sm">
        {/* ── Header ── */}
       <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">

          <div className="flex items-center gap-3">

            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#32598A] text-white">
              <GraduationCap size={18} />
            </span>

            <div>
              <h2 className="text-lg font-semibold tracking-tight text-slate-900">
                Students
              </h2>

              <p className="text-xs text-slate-500">
                View and manage all students in your institution.
              </p>
            </div>

          </div>

          <div className="flex flex-wrap items-center gap-1.5">

            <button
              type="button"
              onClick={downloadStudents}
              className="btn-secondary h-7 gap-1 rounded-lg border-slate-200 bg-white px-2.5 text-[11px] text-slate-700 hover:border-[#8fb0cd] hover:bg-[#eef3f8] hover:text-[#264867]"
            >
              <FileSpreadsheet size={12} />
              Export Excel
            </button>

            <button
              type="button"
              onClick={() => setIsHelpOpen(true)}
              className="btn-secondary h-7 gap-1 rounded-lg border-slate-200 bg-white px-2.5 text-[11px] text-slate-700 hover:border-[#8fb0cd] hover:bg-[#eef3f8] hover:text-[#264867]"
            >
              <CircleHelp size={12} />
              Help
            </button>

            <button
              type="button"
              onClick={downloadTemplate}
              className="btn-secondary h-7 gap-1 rounded-lg border-slate-200 bg-white px-2.5 text-[11px] text-slate-700 hover:border-[#8fb0cd] hover:bg-[#eef3f8] hover:text-[#264867]"
            >
              <Download size={12} />
              Download Template
            </button>

            <label
              className="btn-secondary h-7 cursor-pointer gap-1 rounded-lg border-slate-200 bg-white px-2.5 text-[11px] text-slate-700 hover:border-[#8fb0cd] hover:bg-[#eef3f8] hover:text-[#264867]"
            >
              <Upload size={12} />
              Upload Student List

              <input
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={handleExcelUpload}
              />
            </label>

            <button
              type="button"
              onClick={() => {
                setIsAddPanelOpen(true);
                void loadRegistrationNumber();
              }}
              className="btn-primary h-7 gap-1 rounded-lg border-orange-500 bg-orange-500 px-2.5 text-[11px] text-white shadow-sm hover:bg-orange-600 hover:shadow-md"
            >
              <Plus size={12} />
              Add Student
            </button>

            <button
              type="button"
              onClick={(event) => {
                setFilterAnchorRect(
                  event.currentTarget.getBoundingClientRect()
                );
                setIsFilterPanelOpen(true);
              }}
              className="btn-secondary h-7 gap-1 rounded-lg border-slate-200 bg-white px-2.5 text-[11px] text-slate-700 hover:border-[#8fb0cd] hover:bg-[#eef3f8] hover:text-[#264867]"
            >
              <Search size={12} />
              Search By
            </button>

          </div>

        </div>

       

        {!isLoadingList && !hasStudents ? (
          <p className="text-sm text-muted">No students found. Add students or adjust your filters.</p>
        ) : null}

        {/*
          ── Table ──
          Only shown at xl+ (1280px): the sidebar (256px) leaves less than the
          table's 900px min-width available between lg (1024px) and xl, which
          would force horizontal scrolling. The card list below covers every
          screen narrower than that instead, with nothing clipped or hidden.
        */}
        <div className="flex min-h-0 flex-1 flex-col max-xl:hidden bg-white">

          {/* ===================== TOP ===================== */}
         <div className="mb-3 flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 pb-2">

          <div className="flex items-center gap-1.5">
            <span className="rounded-md bg-[#eef3f8] px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#264867]">
              Sort By
            </span>

            <button
              type="button"
              onClick={() => handleSort("Name")}
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                sortBy === "Name"
                  ? "bg-[#264867] text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              Name

              {sortBy === "Name" &&
                (sortOrder === "asc" ? (
                  <ChevronUp size={13} />
                ) : (
                  <ChevronDown size={13} />
                ))}
            </button>

            <button
              type="button"
              onClick={() => handleSort("RegistrationNumber")}
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                sortBy === "RegistrationNumber"
                  ? "bg-[#264867] text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              Registration #

              {sortBy === "RegistrationNumber" &&
                (sortOrder === "asc" ? (
                  <ChevronUp size={13} />
                ) : (
                  <ChevronDown size={13} />
                ))}
            </button>

            <button
              type="button"
              onClick={() => handleSort("CreatedAt")}
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                sortBy === "CreatedAt"
                  ? "bg-[#264867] text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              Date Added

              {sortBy === "CreatedAt" &&
                (sortOrder === "asc" ? (
                  <ChevronUp size={13} />
                ) : (
                  <ChevronDown size={13} />
                ))}
            </button>
          </div>

          <div className="hidden items-center gap-2 lg:flex">
            {pendingCount > 0 && (
              <button
                onClick={handleConfirmAllStudents}
                disabled={isConfirmingAll}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isConfirmingAll ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    Confirming...
                  </>
                ) : (
                  <>
                    <CheckCircle size={13} />
                    Confirm All Pending ({pendingCount})
                  </>
                )}
              </button>
            )}

            <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-2.5 py-1">
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-slate-600">
                <input
                  type="checkbox"
                  checked={statusFilter.active}
                  onChange={(e) =>
                    toggleActiveStatusFilter(e.target.checked)
                  }
                  className="h-3.5 w-3.5 rounded border-slate-300 accent-emerald-600"
                />
                Active
              </label>

              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-slate-600">
                <input
                  type="checkbox"
                  checked={statusFilter.inactive}
                  onChange={(e) =>
                    toggleInactiveStatusFilter(e.target.checked)
                  }
                  className="h-3.5 w-3.5 rounded border-slate-300 accent-amber-600"
                />
                Deactive
              </label>
            </div>

            <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-600">
              <Users size={11} />
              {totalItems} {totalItems === 1 ? "Student" : "Students"}
            </div>

            <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-500">
              Active Sort:
              <span className="font-semibold text-slate-800">
                {sortBy}
              </span>
            </div>
          </div>

        </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-auto max-xl:hidden">

            <table className="w-full min-w-[900px] border-collapse text-left text-sm">

              <thead className="sticky top-0 z-10 bg-white">
                <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2">Student</th>
                  <th className="px-3 py-2">Contact Details</th>
                  <th className="px-3 py-2">Enrollment</th>
                  <th className="px-3 py-2">Confirmation</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Registered</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>

              <tbody>
                {isLoadingList
                  ? Array.from({ length: Math.min(pageSize, 6) }).map((_, index) => (
                      <StudentRowSkeletonDesktop key={index} />
                    ))
                  : students.map((student) => (
                    <tr
                      key={student.id}
                      onClick={() =>
                        router.push(`/dashboard/students/${student.id}`)
                      }
                      className="cursor-pointer border-b border-slate-100 align-top transition-colors hover:bg-slate-50"
                    >

                      {/* Student: Icon, Name, Reg No, Grade */}
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-3">

                          <div
                            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white ${getStudentAvatarColor(
                              student.id
                            )}`}
                          >
                            <GraduationCap size={16} />
                          </div>

                          <div className="min-w-0">

                            <p className="truncate text-sm font-semibold text-slate-900">
                              {student.name}{" "}
                              <span className="font-normal text-slate-500">
                                ({student.registrationNumber})
                              </span>
                            </p>

                            <div className="mt-1 flex flex-col items-start gap-1">

                              <span className="inline-flex rounded-md bg-[#eef3f8] px-1.5 py-0.5 text-[10px] font-medium text-[#264867]">
                                {formatGradeLabel(student.grade?.GradeDesc ?? "")}
                              </span>

                            </div>

                          </div>

                        </div>
                      </td>

                      {/* Contact Details: Contact 1 / Contact 2, Email */}
                      <td className="max-w-[220px] px-3 py-3">
                        <div className="space-y-1">

                          <div className="flex items-center gap-1.5 text-xs text-slate-700">
                            <Phone size={12} className="shrink-0 text-[#32598A]" />
                            {student.contact01 || "—"} / {student.contact02 || "—"}
                          </div>

                          <div className="flex min-w-0 items-center gap-1.5 text-xs text-slate-700">
                            <Mail size={12} className="shrink-0 text-rose-500" />
                            <span className="truncate">
                              {student.email || "—"}
                            </span>
                          </div>

                        </div>
                      </td>

                      {/* Enrollment (Registration Source) */}
                      <td className="px-3 py-3">
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                            registrationSourceClasses[
                              student.StudentRegistrationSource as keyof typeof registrationSourceClasses
                            ] || "border-slate-200 bg-slate-100 text-slate-700"
                          }`}
                        >
                          {student.StudentRegistrationSource}
                        </span>
                      </td>

                      {/* Confirmation Status */}
                      <td
                        className="px-3 py-3"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {student.StudentConfirmationStatus === "PENDING" ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => handleConfirmStudent(student)}
                              className="inline-flex items-center gap-1 rounded-full bg-emerald-500 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-emerald-600"
                            >
                              <CheckCircle size={12} />
                              Confirm
                            </button>

                            <button
                              onClick={() => handleDeclineStudent(student)}
                              className="inline-flex items-center gap-1 rounded-full bg-red-500 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-red-600"
                            >
                              <XCircle size={12} />
                              Decline
                            </button>
                          </div>
                        ) : student.StudentConfirmationStatus === StudentConfirmationStatus.APPROVED ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                              <CheckCircle size={12} />
                              Confirmed
                            </span>
                          ) : student.StudentConfirmationStatus === StudentConfirmationStatus.REJECTED ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-[11px] font-semibold text-red-700">
                              <XCircle size={12} />
                              Declined
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-semibold text-slate-700">
                              Unknown
                            </span>
                          )}
                      </td>

                      {/* Status: Active / Inactive / Deleted */}
                      <td className="px-3 py-3 align-top">
                        <span
                          className={`inline-block rounded-md px-2 py-0.5 text-[10px] font-medium ${
                            student.status === 0
                              ? "bg-emerald-50 text-emerald-700"
                              : student.status === 1
                              ? "bg-amber-50 text-amber-700"
                              : "bg-slate-100 text-slate-700"
                          }`}
                        >
                          {student.status === 0
                            ? "Active"
                            : student.status === 1
                            ? "Inactive"
                            : "Deleted"}
                        </span>

                        {student.status === 1 && (
                          <div className="mt-1 flex max-w-[200px] items-start gap-1 text-[10px] leading-4 text-slate-500">
                            <span className="line-clamp-2">
                              {student.deactivationReason || "No reason recorded"}
                            </span>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                askEditDeactivationReason(
                                  student.id,
                                  student.deactivationReason
                                );
                              }}
                              title="Edit reason"
                              aria-label="Edit deactivation reason"
                              className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-[#264867]"
                            >
                              <Pencil size={11} />
                            </button>
                          </div>
                        )}
                      </td>

                      {/* Registered At */}
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1.5 text-xs text-slate-600">
                          <CalendarDays size={12} className="text-emerald-500" />
                          {formatRegisteredDate(student.createdAt)}
                        </div>
                      </td>

                      {/* Actions */}
                      <td
                        className="px-3 py-3"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="flex items-center justify-end gap-1.5">

                          <button
                            onClick={() => handleEditStudent(student)}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#b9cfe3] bg-white px-2.5 text-xs font-medium text-[#264867] hover:bg-[#eef3f8]"
                          >
                            <Pencil size={13} />
                            Edit
                          </button>

                          <button
                            onClick={(event) => askDeleteStudent(event, student.id)}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-200 bg-white px-2.5 text-xs font-medium text-red-600 hover:bg-red-50"
                          >
                            <Trash2 size={13} />
                            Delete
                          </button>

                          {student.status === 0 ? (
                            <button
                              onClick={(event) => askDeactivateStudent(event, student.id)}
                              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-orange-200 bg-white px-2.5 text-xs font-medium text-orange-700 hover:bg-orange-50"
                            >
                              <Ban size={13} />
                              Deactivate
                            </button>
                          ) : (
                            <button
                              onClick={(event) => askActivateStudent(event, student.id)}
                              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-2.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                            >
                              <CheckCircle size={13} />
                              Activate
                            </button>
                          )}

                        </div>
                      </td>

                    </tr>
                  ))}
              </tbody>

            </table>

          </div>
        </div>

        <div className="hidden min-h-0 flex-1 flex-col max-xl:flex">
          <div className="mb-3 flex shrink-0 flex-col gap-2 border-b border-slate-200 pb-2">

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-md bg-[#eef3f8] px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#264867]">
              Sort By
            </span>

            <button
              type="button"
              onClick={() => handleSort("Name")}
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                sortBy === "Name"
                  ? "bg-[#264867] text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              Name

              {sortBy === "Name" &&
                (sortOrder === "asc" ? (
                  <ChevronUp size={13} />
                ) : (
                  <ChevronDown size={13} />
                ))}
            </button>

            <button
              type="button"
              onClick={() => handleSort("RegistrationNumber")}
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                sortBy === "RegistrationNumber"
                  ? "bg-[#264867] text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              Registration #

              {sortBy === "RegistrationNumber" &&
                (sortOrder === "asc" ? (
                  <ChevronUp size={13} />
                ) : (
                  <ChevronDown size={13} />
                ))}
            </button>

            <button
              type="button"
              onClick={() => handleSort("CreatedAt")}
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                sortBy === "CreatedAt"
                  ? "bg-[#264867] text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              Date Added

              {sortBy === "CreatedAt" &&
                (sortOrder === "asc" ? (
                  <ChevronUp size={13} />
                ) : (
                  <ChevronDown size={13} />
                ))}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">

            {pendingCount > 0 && (
              <button
                onClick={handleConfirmAllStudents}
                disabled={isConfirmingAll}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isConfirmingAll ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    Confirming...
                  </>
                ) : (
                  <>
                    <CheckCircle size={13} />
                    Confirm All Pending ({pendingCount})
                  </>
                )}
              </button>
            )}

            <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-2.5 py-1">
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-slate-600">
                <input
                  type="checkbox"
                  checked={statusFilter.active}
                  onChange={(e) =>
                    toggleActiveStatusFilter(e.target.checked)
                  }
                  className="h-3.5 w-3.5 rounded border-slate-300 accent-emerald-600"
                />
                Active
              </label>

              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-slate-600">
                <input
                  type="checkbox"
                  checked={statusFilter.inactive}
                  onChange={(e) =>
                    toggleInactiveStatusFilter(e.target.checked)
                  }
                  className="h-3.5 w-3.5 rounded border-slate-300 accent-amber-600"
                />
                Deactive
              </label>
            </div>

            <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-600">
              <Users size={11} />
              {totalItems} {totalItems === 1 ? "Student" : "Students"}
            </div>

            <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-500">
              Active Sort:
              <span className="font-semibold text-slate-800">
                {sortBy}
              </span>
            </div>

          </div>

        </div>
          <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {isLoadingList
            ? Array.from({ length: Math.min(pageSize, 6) }).map((_, index) => (
                <StudentRowSkeletonMobile key={index} />
              ))
            : students.map((student) => (
            <div
              key={student.id}
              onClick={() =>
                router.push(`/dashboard/students/${student.id}`)
              }
              className="cursor-pointer overflow-hidden rounded-xl border border-slate-200 bg-white transition-all hover:shadow-sm"
            >
              {/* Header */}
              <div className="border-b border-slate-100 p-3">
                <div className="flex items-start justify-between">

                  <div className="flex items-center gap-2.5">

                    <div
                      className={`flex h-10 w-10 items-center justify-center rounded-full text-white ${getStudentAvatarColor(
                        student.id
                      )}`}
                    >
                      <GraduationCap size={18} />
                    </div>

                    <div>

                      <span className="inline-flex rounded-md bg-[#eef3f8] px-2 py-0.5 text-[10px] font-semibold text-[#264867]">
                        {student.registrationNumber ?? "—"}
                      </span>

                      <h3 className="mt-1 text-sm font-semibold text-slate-900">
                        {student.name}
                      </h3>

                      <span
                        className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          student.status === 0
                            ? "bg-emerald-100 text-emerald-700"
                            : student.status === 1
                            ? "bg-amber-100 text-amber-700"
                            : "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {student.status === 0
                          ? "Active"
                          : student.status === 1
                          ? "Inactive"
                          : "Deleted"}
                      </span>

                      {student.status === 1 && (
                        <div className="mt-1 flex items-start gap-1 text-[10px] leading-4 text-slate-500">
                          <span className="line-clamp-2">
                            {student.deactivationReason || "No reason recorded"}
                          </span>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              askEditDeactivationReason(
                                student.id,
                                student.deactivationReason
                              );
                            }}
                            title="Edit reason"
                            aria-label="Edit deactivation reason"
                            className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-[#264867]"
                          >
                            <Pencil size={11} />
                          </button>
                        </div>
                      )}

                    </div>
                  </div>

                </div>
              </div>

              {/* Details */}
              <div className="space-y-2.5 p-3">

                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#eef3f8] text-[#264867]">
                    <GraduationCap size={14} />
                  </div>

                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">
                      Grade
                    </p>

                    <p className="text-sm font-medium text-slate-800">
                      {formatGradeLabel(student.grade?.GradeDesc ?? "")}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#eef3f8] text-[#32598A]">
                    <Phone size={14} />
                  </div>

                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">
                      Primary Contact
                    </p>

                    <p className="text-sm font-medium text-slate-800">
                      {student.contact01 || "—"}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#dce7f1] text-[#264867]">
                    <PhoneCall size={14} />
                  </div>

                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">
                      Secondary Contact
                    </p>

                    <p className="text-sm font-medium text-slate-800">
                      {student.contact02 || "—"}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-50 text-rose-500">
                    <Mail size={14} />
                  </div>

                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">
                      Email
                    </p>

                    <p className="break-all text-sm font-medium text-slate-800">
                      {student.email || "—"}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
                    <BookOpen size={14} />
                  </div>

                  <div className="flex-1">
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
                      Classes
                    </p>

                    <div className="flex flex-wrap gap-1.5">
                      {student.classes.length > 0 ? (
                        student.classes.map((cls) => (
                          <span
                            key={cls.id}
                            className="rounded-full border border-[#dce7f1] bg-[#eef3f8] px-2 py-0.5 text-[11px] font-medium text-[#264867]"
                          >
                            {cls.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-slate-400">
                          No classes assigned
                        </span>
                      )}
                    </div>
                  </div>
                </div>

              </div>
              <div className="mt-3 flex flex-col gap-3 border-t border-slate-100 pt-3 xl:flex-row xl:items-center xl:justify-between">

                {/* Student Information */}
                <div className="w-full xl:w-auto">

                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4 px-3 pb-3">

                    {/* Registration Source */}
                    <div>
                      <p className="mb-0.5 text-[11px] text-slate-500">
                        Registration Source
                      </p>

                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                          registrationSourceClasses[
                            student.StudentRegistrationSource as keyof typeof registrationSourceClasses
                          ] || "border-slate-200 bg-slate-100 text-slate-700"
                        }`}
                      >
                        {student.StudentRegistrationSource}
                      </span>
                    </div>

                    {/* Registered At */}
                    <div>
                      <p className="mb-0.5 text-[11px] text-slate-500">
                        Registered
                      </p>

                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-700">
                        <CalendarDays size={12} className="text-emerald-500" />
                        {formatRegisteredDate(student.createdAt)}
                      </span>
                    </div>

                    {/* Confirmation Status */}
                    <div onClick={(event) => event.stopPropagation()}>
                      <p className="mb-0.5 text-[11px] text-slate-500">
                        Confirmation Status
                      </p>

                      {student.StudentConfirmationStatus === "PENDING" ? (
                        <button
                          onClick={() => handleConfirmStudent(student)}
                          className="inline-flex items-center gap-1 rounded-full bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-amber-600"
                        >
                          <CheckCircle size={12} />
                          Confirm
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                          <CheckCircle size={12} />
                          Verified
                        </span>
                      )}
                    </div>

                  </div>

                </div>

                {/* Action Buttons */}
                <div
                  onClick={(event) => event.stopPropagation()}
                  className="grid w-full grid-cols-3 gap-1.5 xl:flex xl:w-auto xl:flex-wrap"
                >

                  <button
                    onClick={() => handleEditStudent(student)}
                    className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-[#b9cfe3] bg-white px-2.5 text-xs font-medium text-[#264867] transition hover:bg-[#eef3f8]"
                  >
                    <Pencil size={13} />
                    Edit
                  </button>

                  <button
                    onClick={(event) => askDeleteStudent(event, student.id)}
                    className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-2.5 text-xs font-medium text-red-600 transition hover:bg-red-50"
                  >
                    <Trash2 size={13} />
                    Delete
                  </button>

                  {student.status === 0 ? (
                    <button
                      onClick={(event) => askDeactivateStudent(event, student.id)}
                      className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-orange-200 bg-white px-2.5 text-xs font-medium text-orange-700 transition hover:bg-orange-50"
                    >
                      <Ban size={13} />
                      Deactivate
                    </button>
                  ) : (
                    <button
                      onClick={(event) => askActivateStudent(event, student.id)}
                      className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-2.5 text-xs font-medium text-emerald-700 transition hover:bg-emerald-50"
                    >
                      <CheckCircle size={13} />
                      Activate
                    </button>
                  )}

                </div>

              </div>
            </div>
          ))}
          </div>
        </div>

        {/* ── Pagination ── */}
        <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3 md:flex-row md:items-center md:justify-between">

          {/* Left */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-3">

              <div className="relative">

                <select
                  value={pageSize}
                  onChange={(e) => {
                    const size = Number(e.target.value);

                    setPageSize(size);

                    void loadStudentList(
                      1,
                      filters,
                      sortBy,
                      sortOrder,
                      size
                    );
                  }}
                  className="
                    appearance-none
                    rounded-lg
                    border
                    border-slate-200
                    bg-white
                    py-1.5
                    pl-2.5
                    pr-8
                    text-xs
                    font-medium
                    text-slate-700
                    transition
                    hover:border-[#8fb0cd]
                    focus:border-[#3d6690]
                    focus:outline-none
                  "
                >
                  <option value={5}>5 / Page</option>
                  <option value={10}>10 / Page</option>
                  <option value={20}>20 / Page</option>
                  <option value={50}>50 / Page</option>
                  <option value={100}>100 / Page</option>
                </select>

                <ChevronDown
                  size={12}
                  className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400"
                />

              </div>

              <span className="text-xs text-slate-500">
                Page <strong>{page}</strong> of <strong>{totalPages}</strong>
              </span>

            </div>
          </div>

          {/* Right */}
          <div className="flex items-center gap-1.5">

            {/* First */}
            <button
              disabled={page === 1 || isLoadingList}
              onClick={() => void loadStudentList(1, filters)}
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronsLeft size={14} />
            </button>

            {/* Previous */}
            <button
              disabled={page === 1 || isLoadingList}
              onClick={() => void loadStudentList(page - 1, filters)}
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft size={14} />
            </button>

            {/* Page numbers */}
            <div className="flex items-center gap-1.5">

              {getPaginationRange(page, totalPages).map((p, index) =>
                p === "ellipsis" ? (
                  <span
                    key={`ellipsis-${index}`}
                    className="px-1 text-xs text-slate-400"
                  >
                    …
                  </span>
                ) : (
                  <button
                    key={p}
                    onClick={() => void loadStudentList(p, filters)}
                    disabled={isLoadingList}
                    className={`flex h-7 min-w-[28px] items-center justify-center rounded-lg border text-xs font-semibold transition-all duration-200 ${
                      p === page
                        ? "border-[#264867] bg-[#264867] text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:border-[#8fb0cd] hover:bg-[#eef3f8]"
                    }`}
                  >
                    {p}
                  </button>
                )
              )}

            </div>

            {/* Next */}
            <button
              disabled={page === totalPages || isLoadingList}
              onClick={() => void loadStudentList(page + 1, filters)}
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight size={14} />
            </button>

            {/* Last */}
            <button
              disabled={page === totalPages || isLoadingList}
              onClick={() => void loadStudentList(totalPages, filters)}
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronsRight size={14} />
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
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-xl overflow-y-auto bg-slate-50 shadow-2xl transition-transform duration-300 ${
          isAddPanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="sticky top-0 z-20 border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#dce7f1] text-[#264867]">
                <GraduationCap size={18} />
              </div>

              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-slate-900">
                    Add Student
                  </h2>

                  <span className="rounded-full bg-[#eef3f8] px-2 py-0.5 text-[11px] font-medium text-[#264867]">
                    New
                  </span>
                </div>

                <p className="mt-0.5 text-xs text-slate-500">
                  Create a student profile and assign academic details.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsAddPanelOpen(false)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Close
            </button>
          </div>
        </div>

        <form
          onSubmit={handleCreateStudent}
          className="space-y-4 p-4"
        >


          {/* Basic Details */}
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Basic Information
            </h3>

            <div className="space-y-3">

              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Registration Number
                </label>

                <input
                  value={studentForm.registrationNumber}
                  onChange={(event) => {
                    setStudentForm((prev) => ({
                      ...prev,
                      registrationNumber: event.target.value,
                    }));

                    if (registrationNumberError) {
                      setRegistrationNumberError("");
                    }

                    checkRegistrationNumber(event.target.value, "");
                  }}
                  className={`h-9 w-full rounded-lg bg-white px-3 text-sm ${
                    registrationNumberError
                      ? "border border-red-500 focus:border-red-500 focus:ring-red-500"
                      : "border border-slate-300"
                  }`}
                />

                {registrationNumberError && (
                  <p className="mt-1 text-xs text-red-600">
                    {registrationNumberError}
                  </p>
                )}
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Student Name
                </label>

                <div className="relative">
                  <User
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  />

                  <input
                    required
                    value={studentForm.name}
                    onChange={(event) => {
                      setStudentForm((prev) => ({
                        ...prev,
                        name: event.target.value,
                      }));

                      if (NameError) {
                        setNameError("");
                      }

                      void checkName(
                        event.target.value,
                        "",
                        studentForm.gradeId
                      );
                    }}
                    className={`h-9 w-full rounded-lg bg-white pl-9 pr-3 text-sm ${
                      NameError
                        ? "border border-red-500 focus:border-red-500 focus:ring-red-500"
                        : "border border-slate-300"
                    }`}
                    placeholder="John Doe"
                  />

                  {NameError && (
                    <p className="mt-1 text-xs text-red-600">
                      {NameError}
                    </p>
                  )}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Grade
                </label>

                <div className="relative">
                  <GraduationCap
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 z-10"
                  />

                  <select
                      required
                      value={studentForm.gradeId ?? ""}
                      onChange={(event) => {
                        const nextGradeId = event.target.value
                          ? Number(event.target.value)
                          : null;
                        setStudentForm((prev) => ({
                          ...prev,
                          gradeId: nextGradeId,
                        }));
                        void checkName(studentForm.name, "", nextGradeId);
                      }}
                    >
                      <option value="">Select Grade</option>

                      {grades.map((grade) => (
                        <option
                          key={grade.id}
                          value={grade.id}
                        >
                          {grade.GradeDesc}
                        </option>
                      ))}
                    </select>

                </div>
              </div>
            </div>
          </div>

          {/* Contact Details */}
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Contact Information
            </h3>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Primary Contact
                </label>

                <div className="relative">
                  <Phone
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  />

                  <input
                    value={studentForm.contact01}
                    onChange={(event) =>
                      setStudentForm((prev) => ({
                        ...prev,
                        contact01: event.target.value,
                      }))
                    }
                    className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm"
                    placeholder="+94 77 123 4567"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Secondary Contact
                </label>

                <div className="relative">
                  <PhoneCall
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  />

                  <input
                    value={studentForm.contact02}
                    onChange={(event) =>
                      setStudentForm((prev) => ({
                        ...prev,
                        contact02: event.target.value,
                      }))
                    }
                    className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm"
                    placeholder="+94 71 123 4567"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Email Address
                </label>

                <div className="relative">
                  <Mail
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  />

                  <input
                    type="email"
                    value={studentForm.email}
                    onChange={(event) => {
                      setStudentForm((prev) => ({
                        ...prev,
                        email: event.target.value,
                      }));

                      if (EmailError) {
                        setEmailError("");
                      }

                      checkEmail(event.target.value, "");
                    }}
                    className={`h-9 w-full rounded-lg bg-white pl-9 pr-3 text-sm ${
                      EmailError
                        ? "border border-red-500 focus:border-red-500 focus:ring-red-500"
                        : "border border-slate-300"
                    }`}
                    placeholder="student@email.com"
                  />

                  {EmailError && (
                    <p className="mt-1 text-xs text-red-600">
                      {EmailError}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Sticky Footer */}
          <div className="sticky bottom-0 border-t border-slate-200 bg-white p-3">
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setIsAddPanelOpen(false)}
                className="h-8
                  flex-1
                  rounded-lg
                  bg-white
                  text-sm
                  font-medium
                  text-dark-700
                  border
                  border-gray-300
                  hover:bg-gray-50
                  "
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={isSubmitting || hasValidationErrors}
                className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm font-medium text-white transition ${
                  isSubmitting || hasValidationErrors
                    ? "cursor-not-allowed bg-slate-400"
                    : "bg-[#264867] hover:bg-[#1a3049]"
                }`}
              >
                {isSubmitting && <Loader2 size={14} className="animate-spin" />}
                {isSubmitting ? "Creating student..." : "Create Student"}
              </button>
            </div>
          </div>
        </form>


      </aside>

      {isFilterPanelOpen && filterAnchorRect && (
        <FilterPopover
          rect={filterAnchorRect}
          filters={filters}
          grades={grades}
          onChange={setFilters}
          onClose={() => setIsFilterPanelOpen(false)}
          onClear={() => {
            const cleared = {
              name: "",
              grade: "",
              email: "",
              registrationNumber: "",
            };

            setFilters(cleared);
            void loadStudentList(1, cleared);
            setIsFilterPanelOpen(false);
          }}
          onApply={() => {
            void loadStudentList(1, filters);
            setIsFilterPanelOpen(false);
          }}
        />
      )}

      <button
      type="button"
      aria-label="Close edit student panel"
      onClick={() => setIsEditPanelOpen(false)}
      className={`fixed inset-0 z-40 bg-black/40 transition ${
        isEditPanelOpen
          ? "visible opacity-100"
          : "invisible opacity-0"
      }`}
    />
      <aside
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-xl overflow-y-auto bg-slate-50 shadow-2xl transition-transform duration-300 ${
          isEditPanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="sticky top-0 z-20 border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#dce7f1] text-[#264867]">
                <GraduationCap size={18} />
              </div>

              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-slate-900">
                    Edit Student
                  </h2>

                  <span className="rounded-full bg-[#eef3f8] px-2 py-0.5 text-[11px] font-medium text-[#264867]">
                    Existing
                  </span>
                </div>

                <p className="mt-0.5 text-xs text-slate-500">
                  Update student profile and assign academic details.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsEditPanelOpen(false)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Close
            </button>
          </div>
        </div>

        <form
          onSubmit={handleUpdateStudent}
          className="space-y-4 p-4"
        >


          {/* Basic Details */}
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Basic Information
            </h3>

            <div className="space-y-3">

              <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Registration Number
              </label>

              <div className="relative">
                <input
                  value={editStudentForm.registrationNumber}
                  onChange={(event) => {
                    setEditStudentForm((prev) => ({
                      ...prev,
                      registrationNumber: event.target.value,
                    }));

                    if (registrationNumberError) {
                      setRegistrationNumberError("");
                    }
                  }}
                  onBlur={() =>
                    void checkRegistrationNumber(
                      editStudentForm.registrationNumber,
                      editStudentForm.id
                    )
                  }
                  className={`h-9 w-full rounded-lg border bg-white px-3 pr-10 text-sm ${
                    registrationNumberError
                      ? "border-red-500 focus:border-red-500"
                      : "border-slate-300"
                  }`}
                />

                {isCheckingRegistrationNumber && (
                  <Loader2
                    size={16}
                    className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-slate-400"
                  />
                )}
              </div>

              {registrationNumberError && (
                <p className="mt-1 text-xs text-red-600">
                  {registrationNumberError}
                </p>
              )}
            </div>

              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Student Name
                </label>

                <div className="relative">
                  <User
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  />

                  <input
                    required
                    value={editStudentForm.name}
                    onChange={(event) => {
                      setEditStudentForm((prev) => ({
                        ...prev,
                        name: event.target.value,
                      }));

                      if (NameError) {
                        setNameError("");
                      }
                    }}
                    onBlur={() =>
                      void checkName(
                        editStudentForm.name,
                        editStudentForm.id,
                        editStudentForm.gradeId
                      )
                    }
                    className={`h-9 w-full rounded-lg bg-white pl-9 pr-3 text-sm ${
                      NameError
                        ? "border border-red-500 focus:border-red-500 focus:ring-red-500"
                        : "border border-slate-300"
                    }`}
                    placeholder="John Doe"
                  />
                  {NameError && (
                    <p className="mt-1 text-xs text-red-600">{NameError}</p>
                  )}
                   {isCheckingName && (
                  <Loader2
                    size={16}
                    className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-slate-400"
                  />
                )}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Grade
                </label>

                <div className="relative">
                  <GraduationCap
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 z-10"
                  />

                  <select
                      required
                      value={editStudentForm.gradeId ?? ""}
                      onChange={(event) => {
                        const nextGradeId = event.target.value
                          ? Number(event.target.value)
                          : null;
                        setEditStudentForm((prev) => ({
                          ...prev,
                          gradeId: nextGradeId,
                        }));
                        void checkName(
                          editStudentForm.name,
                          editStudentForm.id,
                          nextGradeId
                        );
                      }}
                    >
                      <option value="">Select Grade</option>

                      {grades.map((grade) => (
                        <option
                          key={grade.id}
                          value={grade.id}
                        >
                          {grade.GradeDesc}
                        </option>
                      ))}
                    </select>

                </div>
              </div>
            </div>
          </div>

          {/* Contact Details */}
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Contact Information
            </h3>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Primary Contact
                </label>

                <div className="relative">
                  <Phone
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  />

                  <input
                    value={editStudentForm.contact01}
                    onChange={(event) =>
                      setEditStudentForm((prev) => ({
                        ...prev,
                        contact01: event.target.value,
                      }))
                    }
                    className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm"
                    placeholder="+94 77 123 4567"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Secondary Contact
                </label>

                <div className="relative">
                  <PhoneCall
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  />

                  <input
                    value={editStudentForm.contact02}
                    onChange={(event) =>
                      setEditStudentForm((prev) => ({
                        ...prev,
                        contact02: event.target.value,
                      }))
                    }
                    className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm"
                    placeholder="+94 71 123 4567"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Email Address
                </label>

                <div className="relative">
                  <Mail
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  />

                  <input
                    type="email"
                    value={editStudentForm.email}
                    onChange={(event) =>{
                      setEditStudentForm((prev) => ({
                        ...prev,
                        email: event.target.value,
                      }));
                      if(EmailError){
                        setEmailError("");
                      }
                    }}
                    onBlur={()=>{
                      void checkEmail(
                        editStudentForm.email,
                        editStudentForm.id
                      )
                    }}
                    className={`h-9 w-full rounded-lg bg-white pl-9 pr-3 text-sm ${
                      EmailError
                        ? "border border-red-500 focus:border-red-500 focus:ring-red-500"
                        : "border border-slate-300"
                    }`}
                    placeholder="student@email.com"
                  />
                  {EmailError && (
                    <p className="mt-1 text-xs text-red-600">{EmailError}</p>
                  )}
                   {isCheckingEmail && (
                  <Loader2
                    size={16}
                    className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-slate-400"
                  />
                )}
                </div>
              </div>
            </div>
          </div>

          {/* Sticky Footer */}
          <div className="sticky bottom-0 border-t border-slate-200 bg-white p-3">
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setIsEditPanelOpen(false)}
                className="h-8
                  flex-1
                  rounded-lg
                  bg-white
                  text-sm
                  font-medium
                  text-dark-700
                  border
                  border-gray-300
                  hover:bg-gray-50
                  "
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={isSubmitting || hasValidationErrors}
                className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm font-medium text-white ${
                  isSubmitting || hasValidationErrors
                    ? "cursor-not-allowed bg-slate-400"
                    : "bg-[#264867] hover:bg-[#1a3049]"
                }`}
              >
                {isSubmitting && <Loader2 size={14} className="animate-spin" />}
                {isSubmitting ? "Updating student..." : "Update Student"}
              </button>
            </div>
          </div>
        </form>


      </aside>

        <button
        type="button"
        aria-label="Close import preview panel"
        onClick={() => setIsImportPreviewOpen(false)}
        className={`fixed inset-0 z-40 bg-black/40 transition ${
          isImportPreviewOpen
            ? "visible opacity-100"
            : "invisible opacity-0"
        }`}
      />

      <aside
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-5xl flex-col bg-slate-50 shadow-2xl transition-transform duration-300 ${
          isImportPreviewOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#eef3f8] text-[#264867]">
              <FileSpreadsheet size={16} />
            </span>
            <div>
              <h2 className="text-[14px] font-semibold text-slate-900">Import Student Preview</h2>
              <p className="mt-0.5 text-[11px] text-slate-500">
                Review and edit the uploaded students before importing.
              </p>
              <span className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                <Users size={10} />
                {importStudents.length} record{importStudents.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsImportPreviewOpen(false)}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50"
          >
            <X size={12} />
            Close
          </button>
        </div>

        {importErrors.length > 0 && (
          <div className="mx-4 mt-3 rounded-lg border border-rose-200 bg-rose-50 p-2.5">
            <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-rose-700">
              <XCircle size={12} />
              Validation errors
            </p>
            <ul className="space-y-0.5 text-[10px] leading-4 text-rose-600">
              {importErrors.map((error, index) => (
                <li key={index}>
                  Row {error.row} &mdash; {error.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Table */}
        <div className="flex-1 overflow-auto px-4 py-3">
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full min-w-[860px] text-[11px]">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                  <th className="px-2.5 py-2 text-left font-semibold">
                    <span className="inline-flex items-center gap-1"><Hash size={11} />Reg No</span>
                  </th>
                  <th className="px-2.5 py-2 text-left font-semibold">
                    <span className="inline-flex items-center gap-1"><User size={11} />Student Name</span>
                  </th>
                  <th className="px-2.5 py-2 text-left font-semibold">
                    <span className="inline-flex items-center gap-1"><GraduationCap size={11} />Grade</span>
                  </th>
                  <th className="px-2.5 py-2 text-left font-semibold">
                    <span className="inline-flex items-center gap-1"><Phone size={11} />Primary Contact</span>
                  </th>
                  <th className="px-2.5 py-2 text-left font-semibold">
                    <span className="inline-flex items-center gap-1"><PhoneCall size={11} />Secondary Contact</span>
                  </th>
                  <th className="px-2.5 py-2 text-left font-semibold">
                    <span className="inline-flex items-center gap-1"><Mail size={11} />Email</span>
                  </th>
                  <th className="w-8 px-2 py-2" />
                </tr>
              </thead>

              <tbody>
                {paginatedStudents.map((student: ImportStudentRow, index: number) => {
                  const globalIndex =
                    (previewPage - 1) * IMPORT_PREVIEW_PAGE_SIZE + index;
                  const inputClass =
                    "w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 outline-none transition focus:border-[#3d6690]";
                  return (
                    <tr
                      key={globalIndex}
                      className="border-b border-slate-100 last:border-0"
                    >
                      <td className="px-2 py-1.5 align-top">
                        <input
                          value={student.registrationNumber}
                          onChange={(e) =>
                            updateImportStudent(globalIndex, {
                              registrationNumber: e.target.value,
                            })
                          }
                          className={`${inputClass} min-w-[96px]`}
                        />
                      </td>

                      <td className="px-2 py-1.5 align-top">
                        <input
                          value={student.studentName}
                          onChange={(e) =>
                            updateImportStudent(globalIndex, {
                              studentName: e.target.value,
                            })
                          }
                          className={`${inputClass} min-w-[150px]`}
                        />
                      </td>

                      <td className="px-2 py-1.5 align-top">
                        <select
                          value={student.gradeId ?? ""}
                          onChange={(e) => {
                            const id = e.target.value
                              ? Number(e.target.value)
                              : null;
                            const match = grades.find((g) => g.id === id);
                            updateImportStudent(globalIndex, {
                              gradeId: id,
                              grade: match?.GradeDesc ?? "",
                            });
                          }}
                          className={`${inputClass} min-w-[130px] ${
                            student.gradeId ? "" : "text-slate-400"
                          }`}
                        >
                          <option value="">Select grade</option>
                          {grades.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.GradeDesc}
                            </option>
                          ))}
                        </select>
                      </td>

                      <td className="px-2 py-1.5 align-top">
                        <input
                          type="tel"
                          value={student.primaryContact}
                          onChange={(e) =>
                            updateImportStudent(globalIndex, {
                              primaryContact: e.target.value,
                            })
                          }
                          className={`${inputClass} min-w-[120px]`}
                        />
                      </td>

                      <td className="px-2 py-1.5 align-top">
                        <input
                          type="tel"
                          value={student.secondaryContact}
                          onChange={(e) =>
                            updateImportStudent(globalIndex, {
                              secondaryContact: e.target.value,
                            })
                          }
                          className={`${inputClass} min-w-[120px]`}
                        />
                      </td>

                      <td className="px-2 py-1.5 align-top">
                        <input
                          type="email"
                          value={student.email}
                          onChange={(e) =>
                            updateImportStudent(globalIndex, {
                              email: e.target.value,
                            })
                          }
                          className={`${inputClass} min-w-[160px]`}
                        />
                      </td>

                      <td className="px-2 py-1.5 text-center align-top">
                        <button
                          type="button"
                          onClick={() => removeImportStudent(globalIndex)}
                          title="Remove row"
                          aria-label="Remove row"
                          className="rounded-md p-1 text-slate-300 transition hover:bg-rose-50 hover:text-rose-600"
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  );
                })}

                {importStudents.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-3 py-8 text-center text-[11px] text-slate-400"
                    >
                      No students to import.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {totalPreviewPages > 1 && (
            <div className="mt-3 flex items-center justify-center gap-1">
              <button
                type="button"
                disabled={previewPage <= 1}
                onClick={() => setPreviewPage((prev) => prev - 1)}
                className="inline-flex items-center gap-0.5 rounded-md border border-slate-300 px-2 py-1 text-[11px] text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
              >
                <ChevronLeft size={12} />
                Prev
              </button>

              {Array.from({ length: totalPreviewPages }, (_, i) => i + 1).map(
                (pageNo) => (
                  <button
                    key={pageNo}
                    type="button"
                    onClick={() => setPreviewPage(pageNo)}
                    className={`h-6 w-6 rounded-md text-[11px] font-medium transition ${
                      previewPage === pageNo
                        ? "bg-[#264867] text-white"
                        : "border border-slate-300 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {pageNo}
                  </button>
                )
              )}

              <button
                type="button"
                disabled={previewPage >= totalPreviewPages}
                onClick={() => setPreviewPage((prev) => prev + 1)}
                className="inline-flex items-center gap-0.5 rounded-md border border-slate-300 px-2 py-1 text-[11px] text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
              >
                Next
                <ChevronRight size={12} />
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-200 bg-white px-4 py-2.5">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setIsImportPreviewOpen(false)}
              className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg border border-slate-300 bg-white py-1.5 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50"
            >
              <X size={12} />
              Cancel
            </button>

            <button
              type="button"
              disabled={isImporting || importStudents.length === 0}
              onClick={handleConfirmImport}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#264867] py-1.5 text-[11px] font-semibold text-white transition hover:bg-[#1a3049] disabled:opacity-50"
            >
              {isImporting ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Importing...
                </>
              ) : (
                <>
                  <CheckCircle size={12} />
                  Confirm import ({importStudents.length})
                </>
              )}
            </button>
          </div>
        </div>
      </aside>
        

      {isHelpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">About This Page</p>
                <h3 className="mt-1.5 text-base font-semibold">Student & Guardian Management</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsHelpOpen(false)}
                className="btn-secondary"
              >
                Close
              </button>
            </div>

            <div className="mt-3 space-y-3 text-sm text-muted">
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

      {pendingAction && (
        <ConfirmActionPopover
          rect={pendingAction.rect}
          message={
            pendingAction.type === "delete"
              ? "Are you sure you want to delete this student?"
              : "Are you sure you want to activate this student?"
          }
          confirmLabel={
            pendingAction.type === "delete" ? "Delete" : "Activate"
          }
          tone={pendingAction.type === "activate" ? "positive" : "danger"}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => {
            const { type, studentId } = pendingAction;

            setPendingAction(null);

            if (type === "delete") {
              void handleDeleteStudent(studentId);
            } else {
              void handleActivateStudent(studentId);
            }
          }}
        />
      )}

      {deactivateStudentId &&
        (() => {
          const isReasonEdit =
            students.find((s) => s.id === deactivateStudentId)?.status === 1;

          return (
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4">
              <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-100 text-orange-700">
                    {isReasonEdit ? <Pencil size={15} /> : <Ban size={16} />}
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">
                      {isReasonEdit
                        ? "Edit deactivation reason"
                        : "Deactivate this student?"}
                    </h3>
                    <p className="mt-0.5 text-[12px] leading-5 text-slate-500">
                      {isReasonEdit
                        ? "Update the reason the student sees on their account."
                        : "They won't be able to sign in. The student will see the reason you enter below."}
                    </p>
                  </div>
                </div>

                <label className="mt-4 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Reason <span className="text-red-500">*</span>
                </label>
                <textarea
                  autoFocus
                  value={deactivateReason}
                  onChange={(e) => setDeactivateReason(e.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder="e.g. August payment is overdue"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[#3d6690]"
                />

                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setDeactivateStudentId(null);
                      setDeactivateReason("");
                    }}
                    disabled={isDeactivating}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void handleDeactivateStudent(
                        deactivateStudentId,
                        deactivateReason,
                        isReasonEdit
                      )
                    }
                    disabled={
                      isDeactivating || deactivateReason.trim().length < 3
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
                  >
                    {isDeactivating && (
                      <Loader2 size={13} className="animate-spin" />
                    )}
                    {isDeactivating
                      ? "Saving..."
                      : isReasonEdit
                      ? "Update reason"
                      : "Deactivate"}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
    </section>
  );
}

type ConfirmActionPopoverProps = {
  rect: DOMRect;
  message: string;
  confirmLabel: string;
  tone?: "danger" | "positive";
  onConfirm: () => void;
  onCancel: () => void;
};

type StudentFilters = {
  name: string;
  grade: string;
  email: string;
  registrationNumber: string;
};

type FilterPopoverProps = {
  rect: DOMRect;
  filters: StudentFilters;
  grades: Grade[];
  onChange: (updater: (prev: StudentFilters) => StudentFilters) => void;
  onClose: () => void;
  onClear: () => void;
  onApply: () => void;
};

function FilterPopover({
  rect,
  filters,
  grades,
  onChange,
  onClose,
  onClear,
  onApply,
}: FilterPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const VIEWPORT_MARGIN = 12;

  const viewportWidth =
    typeof window !== "undefined" ? window.innerWidth : 300;

  const POPOVER_WIDTH = Math.min(300, viewportWidth - VIEWPORT_MARGIN * 2);

  const left = Math.min(
    Math.max(rect.right - POPOVER_WIDTH, VIEWPORT_MARGIN),
    viewportWidth - POPOVER_WIDTH - VIEWPORT_MARGIN
  );

  const top = rect.bottom + 8;

  return createPortal(
    <div
      ref={popoverRef}
      style={{
        position: "fixed",
        top,
        left,
        width: POPOVER_WIDTH,
      }}
      className="z-[100] rounded-xl border border-slate-200 bg-white p-4 shadow-xl"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Search By</h3>

        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-50 hover:text-slate-600"
        >
          <X size={14} />
        </button>
      </div>

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onApply();
        }}
      >
        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Registration Number
          </label>

          <div className="relative">
            <Hash
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
            />

            <input
              value={filters.registrationNumber}
              onChange={(e) =>
                onChange((prev) => ({
                  ...prev,
                  registrationNumber: e.target.value,
                }))
              }
              placeholder="Search by registration number..."
              className="control-input pl-8 text-sm"
            />
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Student Name
          </label>

          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
            />

            <input
              value={filters.name}
              onChange={(e) =>
                onChange((prev) => ({ ...prev, name: e.target.value }))
              }
              placeholder="Search student..."
              className="control-input pl-8 text-sm"
            />
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Student Email
          </label>

          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
            />

            <input
              type="text"
              value={filters.email}
              onChange={(e) =>
                onChange((prev) => ({ ...prev, email: e.target.value }))
              }
              placeholder="Search by email..."
              className="control-input pl-8 text-sm"
            />
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Grade
          </label>

          <div className="relative">
            <BookOpen
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 z-10 -translate-y-1/2 text-slate-400"
            />

            <ChevronDown
              size={14}
              className="pointer-events-none absolute right-2.5 top-1/2 z-10 -translate-y-1/2 text-slate-400"
            />

            <select
              value={filters.grade}
              onChange={(e) =>
                onChange((prev) => ({ ...prev, grade: e.target.value }))
              }
              className="w-full appearance-none rounded-lg border border-slate-300 bg-white py-1.5 pl-8 pr-8 text-sm"
            >
              <option value="">All Grades</option>

              {grades.map((grade) => (
                <option key={grade.id} value={grade.id}>
                  {grade.GradeDesc}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onClear}
            className="btn-secondary flex-1"
          >
            Clear
          </button>

          <button type="submit" className="btn-primary flex-1">
            Apply
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}

function ConfirmActionPopover({
  rect,
  message,
  confirmLabel,
  tone = "danger",
  onConfirm,
  onCancel,
}: ConfirmActionPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node)
      ) {
        onCancel();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    function handleScroll() {
      onCancel();
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", handleScroll, true);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", handleScroll, true);
    };
  }, [onCancel]);

  const VIEWPORT_MARGIN = 12;

  const viewportWidth =
    typeof window !== "undefined" ? window.innerWidth : 256;

  const POPOVER_WIDTH = Math.min(256, viewportWidth - VIEWPORT_MARGIN * 2);

  const desiredLeft = rect.left + rect.width / 2;
  const minLeft = POPOVER_WIDTH / 2 + VIEWPORT_MARGIN;
  const maxLeft = Math.max(
    viewportWidth - POPOVER_WIDTH / 2 - VIEWPORT_MARGIN,
    minLeft
  );
  const left = Math.min(Math.max(desiredLeft, minLeft), maxLeft);

  const arrowLeft = Math.min(
    Math.max(desiredLeft - (left - POPOVER_WIDTH / 2), 16),
    POPOVER_WIDTH - 16
  );

  const showBelow = rect.top < 160;
  const top = showBelow ? rect.bottom + 10 : rect.top - 10;

  return createPortal(
    <div
      ref={popoverRef}
      style={{
        position: "fixed",
        top,
        left,
        width: POPOVER_WIDTH,
        transform: showBelow ? "translate(-50%, 0)" : "translate(-50%, -100%)",
      }}
      className="z-[100] rounded-xl border border-slate-200 bg-white p-3 shadow-xl"
    >
      <div
        style={{ left: arrowLeft }}
        className={`absolute h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-slate-200 bg-white ${
          showBelow
            ? "-top-1.5 border-l border-t"
            : "top-full -translate-y-1/2 border-b border-r"
        }`}
      />

      <p className="text-sm text-slate-700">{message}</p>

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          Cancel
        </button>

        <button
          type="button"
          onClick={onConfirm}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white ${
            tone === "positive"
              ? "bg-emerald-600 hover:bg-emerald-700"
              : "bg-red-600 hover:bg-red-700"
          }`}
        >
          {confirmLabel}
        </button>
      </div>
    </div>,
    document.body
  );
}

function StudentRowSkeletonDesktop() {
  return (
    <tr className="animate-pulse border-b border-slate-100">
      <td className="px-3 py-3">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 shrink-0 rounded-full bg-slate-200" />
          <div className="space-y-1.5">
            <div className="h-3.5 w-28 rounded bg-slate-200" />
            <div className="h-3 w-16 rounded bg-slate-100" />
          </div>
        </div>
      </td>
      <td className="px-3 py-3">
        <div className="space-y-1.5">
          <div className="h-3 w-24 rounded bg-slate-100" />
          <div className="h-3 w-20 rounded bg-slate-100" />
          <div className="h-3 w-28 rounded bg-slate-100" />
        </div>
      </td>
      <td className="px-3 py-3">
        <div className="h-4 w-16 rounded-md bg-slate-100" />
      </td>
      <td className="px-3 py-3">
        <div className="h-4 w-16 rounded-md bg-slate-100" />
      </td>
      <td className="px-3 py-3">
        <div className="h-4 w-14 rounded-md bg-slate-100" />
      </td>
      <td className="px-3 py-3">
        <div className="h-3 w-16 rounded bg-slate-100" />
      </td>
      <td className="px-3 py-3">
        <div className="flex justify-end gap-1.5">
          <div className="h-8 w-16 rounded-lg bg-slate-100" />
          <div className="h-8 w-16 rounded-lg bg-slate-100" />
          <div className="h-8 w-16 rounded-lg bg-slate-100" />
        </div>
      </td>
    </tr>
  );
}

function StudentRowSkeletonMobile() {
  return (
    <div className="animate-pulse overflow-hidden rounded-xl border border-slate-200 bg-white">

      <div className="border-b border-slate-100 p-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-10 w-10 rounded-full bg-slate-200" />
            <div className="space-y-1.5">
              <div className="h-3 w-16 rounded bg-slate-100" />
              <div className="h-3.5 w-28 rounded bg-slate-200" />
              <div className="h-3 w-12 rounded bg-slate-100" />
            </div>
          </div>
          <div className="h-8 w-16 rounded-lg bg-slate-100" />
        </div>
      </div>

      <div className="space-y-2.5 p-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-slate-100" />
            <div className="flex-1 space-y-1.5">
              <div className="h-2.5 w-16 rounded bg-slate-100" />
              <div className="h-3 w-24 rounded bg-slate-200" />
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-2 border-t border-slate-100 p-3">
        <div className="h-8 flex-1 rounded-lg bg-slate-100" />
        <div className="h-8 flex-1 rounded-lg bg-slate-100" />
        <div className="h-8 flex-1 rounded-lg bg-slate-100" />
      </div>

    </div>
  );
}
