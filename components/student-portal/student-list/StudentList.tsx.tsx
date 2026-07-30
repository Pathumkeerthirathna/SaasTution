"use client";

import { useState } from "react";

import StudentToolbar from "./StudentToolbar";
import StudentFilters, {
  StudentFiltersValue,
} from "./StudentFilters";
import StudentTable from "./StudentTable";
import StudentPagination from "./StudentPagination";
import { StudentRowItem } from "./StudentRow";

type GradeOption = {
  id: string;
  name: string;
};

type StudentListProps = {
  students: StudentRowItem[];

  grades: GradeOption[];

  loading?: boolean;

  selectedIds?: Set<string>;

  enrolledIds?: Set<string>;

  currentPage: number;
  totalPages: number;
  totalRecords: number;
  pageSize: number;

  title?: string;
  subtitle?: string;

  selectable?: boolean;

  showToolbar?: boolean;
  showFilters?: boolean;
  showPagination?: boolean;

  onFilter?: (filters: StudentFiltersValue) => void;

  onRefresh?: () => void;

  onSelect?: (
    studentId: string,
    checked: boolean
  ) => void;

  onPageChange: (page: number) => void;

  onPageSizeChange?: (
    pageSize: number
  ) => void;

  renderActions?: (
    student: StudentRowItem
  ) => React.ReactNode;
};

export default function StudentList({
  students,
  grades,

  loading = false,

  selectedIds = new Set(),
  enrolledIds = new Set(),

  currentPage,
  totalPages,
  totalRecords,
  pageSize,

  title = "Students",
  subtitle,

  selectable = false,

  showToolbar = true,
  showFilters = true,
  showPagination = true,

  onFilter,
  onRefresh,
  onSelect,
  onPageChange,
  onPageSizeChange,

  renderActions,
}: StudentListProps) {
  const [filters, setFilters] =
    useState<StudentFiltersValue>({
      name: "",
      registrationNumber: "",
      gradeId: "",
    });

  const handleSearch = () => {
    onFilter?.(filters);
  };

  const handleReset = () => {
    const reset = {
      name: "",
      registrationNumber: "",
      gradeId: "",
    };

    setFilters(reset);

    onFilter?.(reset);
  };

  return (
    <div className="space-y-6">
      {showToolbar && (
        <StudentToolbar
          title={title}
          subtitle={subtitle}
          selectedCount={selectedIds.size}
          loading={loading}
          onRefresh={onRefresh}
        />
      )}

      {showFilters && (
        <StudentFilters
          value={filters}
          grades={grades}
          loading={loading}
          onChange={setFilters}
          onSearch={handleSearch}
          onReset={handleReset}
        />
      )}

      <StudentTable
        students={students}
        loading={loading}
        selectable={selectable}
        selectedIds={selectedIds}
        enrolledIds={enrolledIds}
        onSelect={onSelect}
        renderActions={renderActions}
      />

      {showPagination && (
        <StudentPagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalRecords={totalRecords}
          pageSize={pageSize}
          loading={loading}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      )}
    </div>
  );
}