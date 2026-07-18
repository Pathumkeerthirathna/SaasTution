"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo,  useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Ban,
  BookOpen,
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleHelp,
  Download,
  Eye,
  FileSpreadsheet,
  GraduationCap,
  Loader2,
  Mail,
  MoreVertical,
  Pencil,
  Phone,
  PhoneCall,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
  User,
  UserCircle2,
  Users,
} from "lucide-react";

// import * as XLSX from "xlsx";
// import { saveAs } from "file-saver";
import { Grade } from "@prisma/client";

import ExcelJS from "exceljs";
import { saveAs } from "file-saver";
import toast from "react-hot-toast";

type StudentListItem = {
  id: string;
  name: string;
  status: number;
  grade: Grade | null;
  contact01: string | null;
  contact02: string | null;
  email: string | null;
  registrationNumber: string | null;
  classes: {
    id: string;
    name: string;
  }[];
  createdAt: string;
};

type ApiError = {
  message?: string;
};

type PaginatedStudentsResponse = {
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

const PAGE_SIZE = 6;

function formatGradeLabel(value: string | null) {
  if (!value) {
    return "-";
  }

  return value.startsWith("GRADE_") ? `Grade ${value.slice(6)}` : value;
}

export function StudentGuardianManagementPanel() {

  const [isCheckingRegistrationNumber, setIsCheckingRegistrationNumber] =
  useState(false);

  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);

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

  const [students, setStudents] = useState<StudentListItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [filters, setFilters] = useState({
    name: "",
    grade: "",
  });

  const [sortBy, setSortBy] = useState("CreatedAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");

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
      setOpenActionMenu(null);

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

      setIsSubmitting(true);
      setErrorMessage(null);
      setSuccessMessage(null);

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
          setErrorMessage(
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
          setSuccessMessage(null);
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
          setErrorMessage(
            payload.error?.message ?? "Failed to activate student."
          );
          return;
        }

        toast.success("Student activated successfully.",{duration:5000});

        setOpenActionMenu(null);

        await loadStudentList(page, filters);
      } catch {
        setErrorMessage("Unable to activate student.");
      }
    }

    async function handleDeactivateStudent(studentId: string) {
      try {
        const response = await fetch(
          `/api/students/${studentId}/deactivate`,
          {
            method: "PUT",
          }
        );

        const payload = await response.json();

        console.log("Deactivate response:", payload);

        if (!response.ok || !payload.success) {
          setErrorMessage(
            payload.error?.message ?? "Failed to deactivate student."
          );
          return;
        }

        toast.success("Student deactivated successfully.");

        setOpenActionMenu(null);

        await loadStudentList(page, filters);
      } catch {
        setErrorMessage("Unable to deactivate student.");
      }
    }

    async function handleDeleteStudent(studentId: string) {
      if (!confirm("Are you sure you want to delete this student?")) {
        return;
      }

      try {
        const response = await fetch(
          `/api/students/${studentId}`,
          {
            method: "DELETE",
          }
        );

        const payload = await response.json();

        if (!response.ok || !payload.success) {
          setErrorMessage(
            payload.error?.message ?? "Failed to delete student."
          );
          return;
        }

        setSuccessMessage("Student deleted successfully.");

        setOpenActionMenu(null);

        await loadStudentList(page, filters);
      } catch {
        setErrorMessage("Unable to delete student.");
      }
    }

  // const actionMenuRef = useRef<HTMLDivElement>(null);

  const [isLoadingList, setIsLoadingList] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

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

  const [openActionMenu, setOpenActionMenu] = useState<string | null>(null);

  const hasStudents = useMemo(() => students.length > 0, [students]);

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
    appliedFilters = { name: "", grade: "" },
    currentSortBy = sortBy,
    currentSortOrder = sortOrder
  ) => {
      setIsLoadingList(true);
      setErrorMessage(null);

      try {
        const query = new URLSearchParams({
          page: String(nextPage),
          pageSize: String(PAGE_SIZE),
        });

        query.set("sortBy", currentSortBy);
        query.set("sortOrder", currentSortOrder);

        if (appliedFilters.name.trim()) {
          query.set("name", appliedFilters.name.trim());
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

        if (!response.ok || !payload.success) {
          setErrorMessage(
            payload.error?.message ??
              "Failed to load students."
          );
          return;
        }

        setStudents(payload.data ?? []);
        setPage(payload.pagination?.page ?? nextPage);
        setTotalPages(
          payload.pagination?.totalPages ?? 1
        );
        setTotalItems(
          payload.pagination?.totalItems ?? 0
        );
      } catch {
        setErrorMessage(
          "Unable to load students right now."
        );
      } finally {
        setIsLoadingList(false);
      }
    },
    [sortBy, sortOrder]
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

    void loadStudentList(1, { name: "", grade: "" });
    void loadGrades();
    void loadRegistrationNumber();

      function handleClickOutside(event: MouseEvent) {
          const target = event.target as HTMLElement;

          if (!target.closest("[data-action-menu]")) {
            setOpenActionMenu(null);
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
    const workbook = new ExcelJS.Workbook();

    // ==========================
    // Grades Sheet (Master Data)
    // ==========================
    

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

    const lastGradeRow = grades.length + 1;

    // Apply dropdowns + formulas for first 500 rows
    for (let row = 2; row <= 500; row++) {
      // ==========================
      // Grade Dropdown (Column C)
      // ==========================
      studentSheet.getCell(`C${row}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`Grades!$B$2:$B$${lastGradeRow}`],
        showErrorMessage: true,
        errorTitle: "Invalid Grade",
        error: "Please select a grade from the dropdown",
      };

      // ==========================
      // Auto GradeId (Column D)
      // ==========================
      studentSheet.getCell(`D${row}`).value = {
        formula: `IFERROR(INDEX(Grades!$A$2:$A$${lastGradeRow},MATCH(C${row},Grades!$B$2:$B$${lastGradeRow},0)),"")`,
      };

      // Make GradeId readonly
      studentSheet.getCell(`D${row}`).protection = {
        locked: true,
      };
    }

    const gradesSheet = workbook.addWorksheet("Grades");

    gradesSheet.columns = [
      { header: "GradeId", key: "gradeId", width: 15 },
      { header: "GradeName", key: "gradeName", width: 25 },
    ];

    grades.forEach((grade) => {
      gradesSheet.addRow({
        gradeId: grade.id,
        gradeName: grade.GradeDesc,
      });
    });

    // Hide Grades sheet
    gradesSheet.state = "hidden";

    // ==========================
    // Unlock editable columns
    // ==========================
    ["A", "B", "C", "E", "F", "G"].forEach((col) => {
      for (let row = 2; row <= 500; row++) {
        studentSheet.getCell(`${col}${row}`).protection = {
          locked: false,
        };
      }
    });

    // ==========================
    // Header styling
    // ==========================
    const headerRow = studentSheet.getRow(1);

    headerRow.font = {
      bold: true,
    };

    headerRow.height = 22;

    // ==========================
    // Freeze header row
    // ==========================
    studentSheet.views = [
      {
        state: "frozen",
        ySplit: 1,
      },
    ];

    // ==========================
    // Protect sheet
    // ==========================
    await studentSheet.protect("student-template", {
      selectLockedCells: true,
      selectUnlockedCells: true,
    });

    // ==========================
    // Download file
    // ==========================
    const buffer = await workbook.xlsx.writeBuffer();

    saveAs(
      new Blob([
        buffer as ArrayBuffer,
      ]),
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

      rows.push({
        registrationNumber:
          row.getCell(1).value?.toString() ?? "",

        studentName:
          row.getCell(2).value?.toString() ?? "",

        grade:
          row.getCell(3).value?.toString() ?? "",

        gradeId:
          Number(row.getCell(4).value) || null,

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
          body: JSON.stringify(importStudents),
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

        setSuccessMessage(
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

    query.set("sortBy", sortBy);
    query.set("sortOrder", sortOrder);

    window.location.href =
      `/api/students/export?${query.toString()}`;
  }

  async function handleCreateStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    console.log("Creating student with data:", studentForm);

    try {
      const response = await fetch("/api/students", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(studentForm),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: ApiError;
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to add student.");
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

      setSuccessMessage("Student added successfully.");
      await loadStudentList(1, filters);
      setIsAddPanelOpen(false);
    } catch {
      setErrorMessage("Unable to add student right now.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const [registrationNumberError, setRegistrationNumberError] = useState("");

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

      setIsCheckingRegistrationNumber(false);

    } catch (error) {
      console.error(error);
    }
  };

  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute -left-28 -top-24 h-72 w-72 rounded-md bg-brand-100 blur-3xl" />
      <div className="pointer-events-none absolute -right-24 top-14 h-72 w-72 rounded-md bg-cyan-100 blur-3xl" />

      <article
        className="
          relative
          space-y-6
          rounded-xl
          border
          border-slate-200
          bg-white
          p-6
          shadow-sm
        "
      >
        {/* ── Header ── */}
       <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">

          <div className="flex items-start gap-4 rounded-2xl border border-green-100 bg-gradient-to-r from-green-50 via-white to-white px-5 py-4 shadow-sm">

            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-green-600 text-white shadow-sm">
              <GraduationCap size={22} />
            </span>

            <div>
              <h2 className="page-title mt-0 text-slate-900">
                Students
              </h2>

              <p className="page-subtitle text-slate-600">
                View and manage all students in your institution.
              </p>
            </div>

          </div>

          <div className="flex flex-wrap gap-3">

            <button
              type="button"
              onClick={downloadStudents}
              className="btn-secondary border-slate-200 bg-white text-slate-700 hover:border-green-300 hover:bg-green-50 hover:text-green-700"
            >
              <FileSpreadsheet size={16} />
              Export Excel
            </button>

            <button
              type="button"
              onClick={() => setIsHelpOpen(true)}
              className="btn-secondary gap-2 border-slate-200 bg-white text-slate-700 hover:border-green-300 hover:bg-green-50 hover:text-green-700"
            >
              <CircleHelp size={16} />
              Help
            </button>

            <button
              type="button"
              onClick={downloadTemplate}
              className="btn-secondary gap-2 border-slate-200 bg-white text-slate-700 hover:border-green-300 hover:bg-green-50 hover:text-green-700"
            >
              <Download size={16} />
              Download Template
            </button>

            <label
              className="btn-secondary cursor-pointer gap-2 border-slate-200 bg-white text-slate-700 hover:border-green-300 hover:bg-green-50 hover:text-green-700"
            >
              <Upload size={16} />
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
              onClick={() => setIsAddPanelOpen(true)}
              className="btn-primary gap-2 bg-orange-500 text-white hover:bg-orange-600 border-orange-500 shadow-sm hover:shadow-md"
            >
              <Plus size={16} />
              Add Student
            </button>

            <button
              type="button"
              onClick={() => setIsFilterPanelOpen(true)}
              className="btn-secondary gap-2 border-slate-200 bg-white text-slate-700 hover:border-green-300 hover:bg-green-50 hover:text-green-700"
            >
              <SlidersHorizontal size={16} />
              Filters
            </button>

          </div>

        </div>

       

        <div className="mb-4 flex justify-end">
          <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
              <Users size={12}/>
              {totalItems} Students
          </span>
      </div>

       
        {isLoadingList ? <p className="text-sm text-muted">Loading students...</p> : null}
        {!isLoadingList && !hasStudents ? (
          <p className="text-sm text-muted">No students found. Add students or adjust your filters.</p>
        ) : null}

        {/* ── Table ── */}
        <div className="max-lg:hidden overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th
                    onClick={() => handleSort("registrationNumber")}
                    className="
                      cursor-pointer
                      px-5
                      py-3
                      text-left
                      text-[11px]
                      font-semibold
                      uppercase
                      tracking-[0.1em]
                      text-muted
                    "
                  >
                    <div className="flex items-center gap-1">
                      Reg No

                      {sortBy === "registrationNumber" &&
                        (sortOrder === "asc" ? (
                          <ArrowUp size={12} />
                        ) : (
                          <ArrowDown size={12} />
                        ))}
                    </div>
                  </th>
                <th
                  onClick={() => handleSort("name")}
                  className="
                    cursor-pointer
                    px-5
                    py-3
                    text-left
                    text-[11px]
                    font-semibold
                    uppercase
                    tracking-[0.1em]
                    text-muted
                  "
                >
                  <div className="flex items-center gap-1">
                    Student

                    {sortBy === "name" &&
                      (sortOrder === "asc" ? (
                        <ArrowUp size={12} />
                      ) : (
                        <ArrowDown size={12} />
                      ))}
                  </div>
                </th>
                <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Grade</th>
                <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Contact 01</th>
                <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Contact 02</th>
                <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Email</th>
                <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Classes</th>
                <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {students.map((student) => (
                <tr key={student.id} className="bg-white transition-colors hover:bg-gray-50/60">
                  {/* Reg No */}
                  <td className="px-5 py-4">
                    <span className="rounded-md border border-brand-100 bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                      {student.registrationNumber ?? "—"}
                    </span>
                  </td>

                  {/* Student */}
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 text-xs font-semibold text-brand-700">
                        {student.name.slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <p className="font-semibold text-foreground">{student.name}</p>
                        {student.status === 0 && (
                          <span className="inline-flex items-center rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                            Active
                          </span>
                        )}

                        {student.status === 1 && (
                          <span className="inline-flex items-center rounded-md bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700">
                            Inactive
                          </span>
                        )}

                        {student.status === 2 && (
                          <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-700">
                            Deleted
                          </span>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* Grade */}
                  <td className="px-5 py-4">
                    <span className="rounded-lg bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700">
                      {formatGradeLabel(student.grade?.GradeDesc??"")}
                    </span>
                  </td>

                  {/* Contacts */}
                  <td className="px-5 py-4 text-sm text-gray-600">{student.contact01 || "—"}</td>
                  <td className="px-5 py-4 text-sm text-gray-600">{student.contact02 || "—"}</td>

                  {/* Email */}
                  <td className="px-5 py-4 text-sm text-gray-600">{student.email || "—"}</td>

                  {/* Classes */}
                  <td className="px-5 py-4">
                    {student.classes.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {student.classes.map((cls) => (
                          <span
                            key={cls.id}
                            className="
                              inline-flex
                              items-center
                              gap-1
                              rounded-md
                              border
                              border-brand-100
                              bg-brand-50
                              px-2
                              py-0.5
                              text-[11px]
                              font-medium
                              text-brand-700"
                          >
                            <BookOpen size={10} />
                            {cls.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-sm text-muted">—</span>
                    )}
                  </td>

                  {/* Actions */}
                  <td className="px-5 py-4">
                    <div className="flex items-center justify-end gap-1">
                      <Link
                        href={`/dashboard/students/${student.id}`}
                        className="
                                inline-flex
                                items-center
                                gap-1.5
                                rounded-md
                                border
                                border-slate-200
                                bg-white
                                px-3
                                py-1.5
                                text-xs
                                font-medium
                                text-slate-700
                                hover:bg-slate-50
                                "
                      >
                        <Eye size={13} />
                        View
                      </Link>
                      
                      <div data-action-menu className="relative">
                          <button
                            type="button"
                            onClick={() =>
                              setOpenActionMenu(
                                openActionMenu === student.id
                                  ? null
                                  : student.id
                              )
                            }
                            className="inline-flex h-7 w-7 items-center justify-center rounded-xl text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                          >
                            <MoreVertical size={15} />
                          </button>

                          {openActionMenu === student.id && (
                            <div
                              className="
                                absolute
                                right-0
                                top-9
                                z-20
                                w-48
                                overflow-hidden
                                rounded-xl
                                border
                                border-slate-200
                                bg-white
                                shadow-xl
                              "
                            >
                              <button
                                type="button"
                                onClick={() => handleEditStudent(student)}
                                className="
                                  flex
                                  w-full
                                  items-center
                                  gap-3
                                  px-4
                                  py-3
                                  text-left
                                  text-sm
                                  text-slate-700
                                  hover:bg-slate-50
                                "
                              >
                                <Pencil size={15} />
                                Edit Student
                              </button>

                              <button
                                type="button"
                                onClick={() => handleActivateStudent(student.id)}
                                className="
                                  flex
                                  w-full
                                  items-center
                                  gap-3
                                  px-4
                                  py-3
                                  text-left
                                  text-sm
                                  text-emerald-700
                                  hover:bg-emerald-50
                                "
                              >
                                <CheckCircle size={15} />
                                Activate
                              </button>

                              <button
                                type="button"
                                onClick={() => handleDeactivateStudent(student.id)}
                                className="
                                  flex
                                  w-full
                                  items-center
                                  gap-3
                                  px-4
                                  py-3
                                  text-left
                                  text-sm
                                  text-amber-700
                                  hover:bg-amber-50
                                "
                              >
                                <Ban size={15} />
                                Deactivate
                              </button>

                              <div className="border-t border-slate-100" />

                              <button
                                type="button"
                                onClick={() => handleDeleteStudent(student.id)}
                                className="
                                  flex
                                  w-full
                                  items-center
                                  gap-3
                                  px-4
                                  py-3
                                  text-left
                                  text-sm
                                  text-red-600
                                  hover:bg-red-50
                                "
                              >
                                <Trash2 size={15} />
                                Delete Student
                              </button>
                            </div>
                          )}
                        </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-4 hidden max-lg:block">
          {students.map((student) => (
            <div
              key={student.id}
              className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lg"
            >
              {/* Header */}
              <div className="border-b border-slate-100 bg-gradient-to-r from-green-50 via-white to-white p-4">
                <div className="flex items-start justify-between">

                  <div className="flex items-center gap-3">

                    <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-green-600 text-white shadow-sm">
                      <UserCircle2 size={28} />
                    </div>

                    <div>

                      <span className="inline-flex rounded-md bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">
                        {student.registrationNumber ?? "—"}
                      </span>

                      <h3 className="mt-2 text-lg font-semibold text-slate-900">
                        {student.name}
                      </h3>

                      <span
                        className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
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

                    </div>
                  </div>

                  <Link
                    href={`/dashboard/students/${student.id}`}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-green-300 hover:bg-green-50 hover:text-green-700"
                  >
                    <Eye size={16} />
                    View
                  </Link>

                </div>
              </div>

              {/* Details */}
              <div className="space-y-4 p-4">

                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-700">
                    <GraduationCap size={18} />
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">
                      Grade
                    </p>

                    <p className="font-medium text-slate-800">
                      {formatGradeLabel(student.grade?.GradeDesc ?? "")}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-green-100 text-green-700">
                    <Phone size={18} />
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">
                      Primary Contact
                    </p>

                    <p className="font-medium text-slate-800">
                      {student.contact01 || "—"}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-100 text-orange-700">
                    <PhoneCall size={18} />
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">
                      Secondary Contact
                    </p>

                    <p className="font-medium text-slate-800">
                      {student.contact02 || "—"}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-100 text-sky-700">
                    <Mail size={18} />
                  </div>

                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-wide text-slate-500">
                      Email
                    </p>

                    <p className="break-all font-medium text-slate-800">
                      {student.email || "—"}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-xl bg-brand-100 text-brand-700">
                    <BookOpen size={18} />
                  </div>

                  <div className="flex-1">
                    <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">
                      Classes
                    </p>

                    <div className="flex flex-wrap gap-2">
                      {student.classes.length > 0 ? (
                        student.classes.map((cls) => (
                          <span
                            key={cls.id}
                            className="rounded-full border border-brand-100 bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700"
                          >
                            {cls.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-sm text-slate-400">
                          No classes assigned
                        </span>
                      )}
                    </div>
                  </div>
                </div>

              </div>

              {/* Actions */}
              <div className="border-t border-slate-100 bg-slate-50 p-4">
                <div className="grid grid-cols-2 gap-2">

                  <Link
                    href={`/dashboard/students/${student.id}`}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Eye size={16} />
                    View
                  </Link>

                  <button
                    type="button"
                    onClick={() => handleEditStudent(student)}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-700 hover:bg-blue-100"
                  >
                    <Pencil size={16} />
                    Edit
                  </button>

                  {student.status === 0 ? (
                    <button
                      type="button"
                      onClick={() => handleDeactivateStudent(student.id)}
                      className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-700 hover:bg-amber-100"
                    >
                      <Ban size={16} />
                      Deactivate
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleActivateStudent(student.id)}
                      className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700 hover:bg-emerald-100"
                    >
                      <CheckCircle size={16} />
                      Activate
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => handleDeleteStudent(student.id)}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 hover:bg-red-100"
                  >
                    <Trash2 size={16} />
                    Delete
                  </button>

                </div>
              </div>
            </div>
          ))}
        </div>

        {/* ── Pagination ── */}
        <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:flex-row md:items-center md:justify-between">

          {/* Left */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-600"
            >
              {PAGE_SIZE} / Page
              <ChevronDown size={14} />
            </button>

            <span className="hidden text-sm text-slate-500 sm:block">
              Page <strong>{page}</strong> of <strong>{totalPages}</strong>
            </span>
          </div>

          {/* Right */}
          <div className="flex items-center gap-2">

            {/* First */}
            <button
              disabled={page === 1 || isLoadingList}
              onClick={() => void loadStudentList(1, filters)}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronsLeft size={16} />
            </button>

            {/* Previous */}
            <button
              disabled={page === 1 || isLoadingList}
              onClick={() => void loadStudentList(page - 1, filters)}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft size={16} />
            </button>

            {/* Scrollable Pages */}
            <div className="max-w-[280px] overflow-x-auto pb-3 scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent">

              <div className="flex gap-2 px-1">

                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <button
                    key={p}
                    onClick={() => void loadStudentList(p, filters)}
                    disabled={isLoadingList}
                    className={`flex h-9 min-w-[36px] items-center justify-center rounded-lg border text-sm font-semibold transition-all duration-200 ${
                      p === page
                        ? "border-brand-700 bg-brand-700 text-white shadow"
                        : "border-slate-200 bg-white text-slate-600 hover:border-brand-300 hover:bg-brand-50"
                    }`}
                  >
                    {p}
                  </button>
                ))}

              </div>

            </div>

            {/* Next */}
            <button
              disabled={page === totalPages || isLoadingList}
              onClick={() => void loadStudentList(page + 1, filters)}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight size={16} />
            </button>

            {/* Last */}
            <button
              disabled={page === totalPages || isLoadingList}
              onClick={() => void loadStudentList(totalPages, filters)}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronsRight size={16} />
            </button>

          </div>

        </div>

        {/* ── Count ── */}
        <p className="text-center text-sm text-muted">
          Showing {students.length > 0 ? (page - 1) * PAGE_SIZE + 1 : 0} to {(page - 1) * PAGE_SIZE + students.length} of {totalItems} {totalItems === 1 ? "student" : "students"}
        </p>
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
        <div className="sticky top-0 z-20 border-b border-slate-200 bg-white px-8 py-6">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-100 text-blue-700">
                <GraduationCap size={22} />
              </div>

              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold text-slate-900">
                    Add Student
                  </h2>

                  <span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
                    New
                  </span>
                </div>

                <p className="mt-1 text-sm text-slate-500">
                  Create a student profile and assign academic details.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsAddPanelOpen(false)}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Close
            </button>
          </div>
        </div>

        <form
          onSubmit={handleCreateStudent}
          className="space-y-6 p-4"
        >

           {errorMessage ? <p className="notice-error">{errorMessage}</p> : null}
           {successMessage ? <p className="notice-success">{successMessage}</p> : null}

          {/* Basic Details */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Basic Information
            </h3>

            <div className="space-y-4">

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Registration Number
                </label>

                <input
                  value={studentForm.registrationNumber}
                  onChange={(event) =>
                    setStudentForm((prev) => ({
                      ...prev,
                      registrationNumber: event.target.value,
                    }))
                  }
                  className="h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
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
                    onChange={(event) =>
                      setStudentForm((prev) => ({
                        ...prev,
                        name: event.target.value,
                      }))
                    }
                    className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm"
                    placeholder="John Doe"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
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
                      onChange={(event) =>
                        setStudentForm((prev) => ({
                          ...prev,
                          gradeId: event.target.value
                            ? Number(event.target.value)
                            : null,
                        }))
                      }
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
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Contact Information
            </h3>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
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
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
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
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
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
                    onChange={(event) =>
                      setStudentForm((prev) => ({
                        ...prev,
                        email: event.target.value,
                      }))
                    }
                    className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm"
                    placeholder="student@email.com"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Sticky Footer */}
          <div className="sticky bottom-0 border-t border-slate-200 bg-white p-4">
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
                disabled={isSubmitting}
                className="h-8
                    flex-1
                    rounded-lg
                    bg-brand-700
                    text-sm
                    font-medium
                    text-white"
              >
                {isSubmitting ? "Creating..." : "Create Student"}
              </button>
            </div>
          </div>
        </form>


      </aside>

      {/* Overlay */}
      <button
        type="button"
        aria-label="Close filter panel"
        onClick={() => setIsFilterPanelOpen(false)}
        className={`fixed inset-0 z-40 bg-black/40 transition ${
          isFilterPanelOpen
            ? "visible opacity-100"
            : "invisible opacity-0"
        }`}
      />

      {/* Drawer */}
      <aside
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-md bg-slate-50 shadow-2xl transition-transform duration-300 ${
          isFilterPanelOpen
            ? "translate-x-0"
            : "translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col">

          {/* Header */}
          <div className="sticky top-0 z-20 border-b border-slate-200 bg-white px-6 py-5">
            <div className="flex items-center justify-between">

              <div className="flex items-center gap-4">

                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-green-100 text-green-700">
                  <SlidersHorizontal size={22} />
                </div>

                <div>
                  <h2 className="text-xl font-bold text-slate-900">
                    Filters
                  </h2>

                  <p className="text-sm text-slate-500">
                    Filter the student list
                  </p>
                </div>

              </div>

              <button
                type="button"
                onClick={() => setIsFilterPanelOpen(false)}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Close
              </button>

            </div>
          </div>

          {/* Body */}
          <div className="flex-1 space-y-6 overflow-y-auto p-6">

            {/* Student Name */}
            <div>

              <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Student Name
              </label>

              <div className="relative">

                <Search
                  size={15}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                />

                <input
                  value={filters.name}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      name: e.target.value,
                    }))
                  }
                  placeholder="Search student..."
                  className="control-input pl-9"
                />

              </div>

            </div>

            {/* Grade */}
            <div>

              <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Grade
              </label>

              <div className="relative">

                <BookOpen
                  size={15}
                  className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-400"
                />

                <ChevronDown
                  size={15}
                  className="pointer-events-none absolute right-3 top-1/2 z-10 -translate-y-1/2 text-slate-400"
                />

                <select
                  value={filters.grade}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      grade: e.target.value,
                    }))
                  }
                  className="
                    w-full
                    appearance-none
                    rounded-lg
                    border
                    border-slate-300
                    bg-white
                    py-2
                    pl-9
                    pr-9
                    text-sm
                  "
                >
                  <option value="">
                    All Grades
                  </option>

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

          {/* Footer */}
          <div className="sticky bottom-0 z-20 border-t border-slate-200 bg-white p-6">

            <div className="flex gap-3">

              <button
                type="button"
                className="btn-secondary flex-1"
                onClick={() => {
                  const cleared = {
                    name: "",
                    grade: "",
                  };

                  setFilters(cleared);

                  void loadStudentList(1, cleared);

                  setIsFilterPanelOpen(false);
                }}
              >
                Clear
              </button>

              <button
                type="button"
                className="btn-primary flex-1"
                onClick={() => {
                  void loadStudentList(1, filters);

                  setIsFilterPanelOpen(false);
                }}
              >
                Apply Filters
              </button>

            </div>

          </div>

        </div>
      </aside>

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
        <div className="sticky top-0 z-20 border-b border-slate-200 bg-white px-8 py-6">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-100 text-blue-700">
                <GraduationCap size={22} />
              </div>

              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold text-slate-900">
                    Edit Student
                  </h2>

                  <span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
                    Existing
                  </span>
                </div>

                <p className="mt-1 text-sm text-slate-500">
                  Update student profile and assign academic details.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsEditPanelOpen(false)}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Close
            </button>
          </div>
        </div>

        <form
          onSubmit={handleUpdateStudent}
          className="space-y-6 p-4"
        >

           {errorMessage ? <p className="notice-error">{errorMessage}</p> : null}
           {successMessage ? <p className="notice-success">{successMessage}</p> : null}

          {/* Basic Details */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Basic Information
            </h3>

            <div className="space-y-4">

              <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
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
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
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
                    onChange={(event) =>
                      setEditStudentForm((prev) => ({
                        ...prev,
                        name: event.target.value,
                      }))
                    }
                    className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm"
                    placeholder="John Doe"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
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
                      onChange={(event) =>
                        setEditStudentForm((prev) => ({
                          ...prev,
                          gradeId: event.target.value
                            ? Number(event.target.value)
                            : null,
                        }))
                      }
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
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Contact Information
            </h3>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
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
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
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
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
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
                    onChange={(event) =>
                      setEditStudentForm((prev) => ({
                        ...prev,
                        email: event.target.value,
                      }))
                    }
                    className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm"
                    placeholder="student@email.com"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Sticky Footer */}
          <div className="sticky bottom-0 border-t border-slate-200 bg-white p-4">
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
                disabled={isSubmitting}
                className="h-8
                    flex-1
                    rounded-lg
                    bg-brand-700
                    text-sm
                    font-medium
                    text-white"
              >
                {isSubmitting ? "Updating..." : "Update Student"}
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
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-7xl overflow-y-auto bg-slate-50 shadow-2xl transition-transform duration-300 ${
          isImportPreviewOpen
            ? "translate-x-0"
            : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="sticky top-0 z-20 border-b border-slate-200 bg-white px-8 py-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-bold text-slate-900">
                Import Student Preview
              </h2>

              <p className="mt-1 text-sm text-slate-500">
                Review uploaded students before importing.
              </p>

              <div className="mt-3">
                <span className="rounded-lg bg-blue-50 px-3 py-1 text-sm text-blue-700">
                  Total Records: {importStudents.length}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsImportPreviewOpen(false)}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Close
            </button>
          </div>
        </div>

        {importErrors.length > 0 && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4">
            <h3 className="mb-2 font-semibold text-red-700">
              Validation Errors
            </h3>

            <ul className="space-y-1 text-sm text-red-600">
              {importErrors.map((error, index) => (
                <li key={index}>
                  Row {error.row} - {error.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Table */}
        <div className="p-6">
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="px-4 py-3 text-left">Reg No</th>
                  <th className="px-4 py-3 text-left">Student Name</th>
                  <th className="px-4 py-3 text-left">Grade</th>
                  <th className="px-4 py-3 text-left">Grade Id</th>
                  <th className="px-4 py-3 text-left">Primary Contact</th>
                  <th className="px-4 py-3 text-left">Secondary Contact</th>
                  <th className="px-4 py-3 text-left">Email</th>
                </tr>
              </thead>

              <tbody>
                {paginatedStudents.map(
                  (student: ImportStudentRow, index: number) => (
                    <tr
                      key={`${student.registrationNumber}-${index}`}
                      className="border-b border-slate-100"
                    >
                      <td className="px-4 py-3">
                        {student.registrationNumber}
                      </td>

                      <td className="px-4 py-3">
                        {student.studentName}
                      </td>

                      <td className="px-4 py-3">
                        {student.grade}
                      </td>

                      <td className="px-4 py-3">
                        {student.gradeId}
                      </td>

                      <td className="px-4 py-3">
                        {student.primaryContact}
                      </td>

                      <td className="px-4 py-3">
                        {student.secondaryContact}
                      </td>

                      <td className="px-4 py-3">
                        {student.email}
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="mt-6 flex items-center justify-center gap-2">
            <button
              type="button"
              disabled={previewPage <= 1}
              onClick={() =>
                setPreviewPage((prev) => prev - 1)
              }
              className="rounded-lg border border-slate-300 px-3 py-2 disabled:opacity-40"
            >
              Previous
            </button>

            {Array.from(
              { length: totalPreviewPages },
              (_, i) => i + 1
            ).map((pageNo) => (
              <button
                key={pageNo}
                type="button"
                onClick={() =>
                  setPreviewPage(pageNo)
                }
                className={`h-9 w-9 rounded-lg ${
                  previewPage === pageNo
                    ? "bg-brand-700 text-white"
                    : "border border-slate-300"
                }`}
              >
                {pageNo}
              </button>
            ))}

            <button
              type="button"
              disabled={
                previewPage >= totalPreviewPages
              }
              onClick={() =>
                setPreviewPage((prev) => prev + 1)
              }
              className="rounded-lg border border-slate-300 px-3 py-2 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 border-t border-slate-200 bg-white p-4">
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() =>
                setIsImportPreviewOpen(false)
              }
              className="flex-1 rounded-lg border border-slate-300 bg-white py-2 text-sm font-medium"
            >
              Cancel
            </button>

            <button
              type="button"
              disabled={isImporting}
              onClick={handleConfirmImport}
              className="flex-1 rounded-lg bg-brand-700 py-2 text-sm font-medium text-white"
            >
              {isImporting
                ? "Importing..."
                : `Confirm Import (${importStudents.length})`}
            </button>
          </div>
        </div>
      </aside>
        

      {isHelpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">About This Page</p>
                <h3 className="mt-2 text-lg font-semibold">Student & Guardian Management</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsHelpOpen(false)}
                className="btn-secondary"
              >
                Close
              </button>
            </div>

            <div className="mt-4 space-y-4 text-sm text-muted">
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
    </section>
  );
}
