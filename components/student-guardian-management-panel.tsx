"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Ban,
  BookOpen,
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Eye,
  Filter,
  GraduationCap,
  Mail,
  MoreVertical,
  Pencil,
  Phone,
  PhoneCall,
  Plus,
  Search,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";

// import * as XLSX from "xlsx";
// import { saveAs } from "file-saver";
import { Grade } from "@prisma/client";

import ExcelJS from "exceljs";
import { saveAs } from "file-saver";

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

const PAGE_SIZE = 6;

function formatGradeLabel(value: string | null) {
  if (!value) {
    return "-";
  }

  return value.startsWith("GRADE_") ? `Grade ${value.slice(6)}` : value;
}

export function StudentGuardianManagementPanel() {

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

  const [sortBy, setSortBy] = useState("registrationNumber");
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

        setSuccessMessage(
          "Student updated successfully."
        );

        await loadStudentList(page, filters);

        setTimeout(() => {
          setIsEditPanelOpen(false);
          setSuccessMessage(null);
        }, 1000);

      } catch {
        setErrorMessage(
          "Unable to update student right now."
        );
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

        setSuccessMessage("Student activated successfully.");

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

        setSuccessMessage("Student deactivated successfully.");

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

  const actionMenuRef = useRef<HTMLDivElement>(null);

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

  // const loadStudentList = useCallback(async (nextPage = 1, appliedFilters = filters) => {
  //   setIsLoadingList(true);
  //   setErrorMessage(null);

  //   try {
  //     const query = new URLSearchParams({
  //       page: String(nextPage),
  //       pageSize: String(PAGE_SIZE),
  //     });

  //     if (appliedFilters.name.trim()) {
  //       query.set("name", appliedFilters.name.trim());
  //     }

  //     if (appliedFilters.grade) {
  //       query.set("grade", appliedFilters.grade);
  //     }

  //     const response = await fetch(`/api/students?${query.toString()}`);
  //     const payload = (await response.json()) as PaginatedStudentsResponse;

  //     if (!response.ok || !payload.success) {
  //       setErrorMessage(payload.error?.message ?? "Failed to load students.");
  //       return;
  //     }

  //     console.log("Loaded students:", payload.data);

  //     setStudents(payload.data ?? []);
  //     setPage(payload.pagination?.page ?? nextPage);
  //     setTotalPages(payload.pagination?.totalPages ?? 1);
  //     setTotalItems(payload.pagination?.totalItems ?? 0);
  //   } catch {
  //     setErrorMessage("Unable to load students right now.");
  //   } finally {
  //     setIsLoadingList(false);
  //   }
  // }, [filters]);

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
    []
  );

  const [grades, setGrades] = useState<Grade[]>([]);

  const [isImportPreviewOpen, setIsImportPreviewOpen] = useState(false);

  const [importStudents, setImportStudents] = useState<any[]>([]);

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

  }, [loadStudentList]);

  // async function downloadTemplate() {
  
  //   const data = [
  //     {
  //       StudentName: "Nethmi Perera",
  //       Grade: "GRADE_07",
  //       PrimaryContact: "0771234567",
  //       SecondaryContact: "0711234567",
  //       Email: "nethmi@gmail.com",
  //     },
  //   ];

  //   const gradeSheetData = grades.map(g => ({
  //     GradeId: g.id,
  //     GradeName: g.GradeDesc,
  //   }));
    

  //   const worksheet = XLSX.utils.json_to_sheet(data);
  //   const workbook = XLSX.utils.book_new();

  //   XLSX.utils.book_append_sheet(
  //     workbook,
  //     worksheet,
  //     "Students"
  //   );

  //   const excelBuffer = XLSX.write(workbook, {
  //     bookType: "xlsx",
  //     type: "array",
  //   });

  //   const file = new Blob(
  //     [excelBuffer],
  //     {
  //       type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  //     }
  //   );

  //   saveAs(file, "StudentTemplate.xlsx");
  // }

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

    const rows: any[] = [];

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
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
              <GraduationCap size={22} />
            </span>
            <div>
              <h2 className="page-title mt-0">Students</h2>
              <p className="page-subtitle">View and manage all students in your institution.</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">

            <button
              type="button"
              onClick={downloadStudents}
              className="btn-secondary"
            >
              Export Excel
            </button>

            <button
              type="button"
              onClick={() => setIsHelpOpen(true)}
              className="btn-secondary gap-2"
            >
              <CircleHelp size={15} />
              Help
            </button>

            <button
              type="button"
              onClick={downloadTemplate}
              className="btn-secondary gap-2"
            >
              Download Template
            </button>

          <label
            className="btn-secondary cursor-pointer gap-2"
          >
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
              className="btn-primary gap-2"
            >
              <Plus size={15} />
              Add Student
            </button>
          </div>

          

        </div>

        <div className="filter-shell">
          <div className="flex flex-wrap items-center gap-3">
            
            {/* Search */}
            <div className="relative min-w-[280px] flex-1 max-w-md">
              
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              />

              <input
                value={filters.name}
                onChange={(event) =>
                  setFilters((prev) => ({
                    ...prev,
                    name: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();

                    void loadStudentList(1, filters);
                  }
                }}
                placeholder="Search students..."
                className="control-input pl-9"
              />

            </div>

            {/* Grade */}
           <div className="relative w-[180px]">
              <BookOpen
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-gray-400"
              />

              <ChevronDown
                size={14}
                className="pointer-events-none absolute right-3 top-1/2 z-10 -translate-y-1/2 text-gray-400"
              />

              <select
                value={filters.grade}
                onChange={(event) => {
                  const selectedGrade = event.target.value;

                  const updatedFilters = {
                    ...filters,
                    grade: selectedGrade,
                  };

                  setFilters(updatedFilters);

                  void loadStudentList(1, updatedFilters);
                }}
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
                <option value="">All Grades</option>

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

            {/* Actions */}
            {/* <button
              type="button"
              onClick={() => void loadStudentList(1, filters)}
              className="btn-primary"
            >
              Apply
            </button> */}

            <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              const clearedFilters = {
                name: "",
                grade: "",
              };

              setFilters(clearedFilters);

              void loadStudentList(1, clearedFilters);
            }}
          >
            Clear
          </button>

            {/* Count */}
            <div className="ml-auto">
              <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
                <Users size={12} />
                {totalItems} Students
              </span>
            </div>
          </div>
        </div>

       
        {isLoadingList ? <p className="text-sm text-muted">Loading students...</p> : null}
        {!isLoadingList && !hasStudents ? (
          <p className="text-sm text-muted">No students found. Add students or adjust your filters.</p>
        ) : null}

        {/* ── Table ── */}
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
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

        {/* ── Pagination ── */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button type="button" className="btn-ghost w-fit gap-2 text-sm" disabled>
            {PAGE_SIZE} per page
            <ChevronDown size={13} />
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isLoadingList || page <= 1}
              onClick={() => void loadStudentList(page - 1, filters)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 transition-colors hover:bg-gray-50 disabled:opacity-40"
            >
              <ChevronLeft size={15} />
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                type="button"
                disabled={isLoadingList}
                onClick={() => void loadStudentList(p, filters)}
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
              disabled={isLoadingList || page >= totalPages}
              onClick={() => void loadStudentList(page + 1, filters)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 transition-colors hover:bg-gray-50 disabled:opacity-40"
            >
              <ChevronRight size={15} />
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

                <input
                  value={editStudentForm.registrationNumber}
                  onChange={(event) =>
                    setEditStudentForm((prev) => ({
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
                  (student: any, index: number) => (
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
