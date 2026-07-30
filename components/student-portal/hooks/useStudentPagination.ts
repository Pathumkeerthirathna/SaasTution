"use client";

import { useCallback, useMemo, useState } from "react";

export type StudentPagination = {
  currentPage: number;
  pageSize: number;
  totalPages: number;
  totalRecords: number;
};

type UseStudentPaginationOptions = {
  initialPage?: number;
  initialPageSize?: number;
};

export function useStudentPagination({
  initialPage = 1,
  initialPageSize = 10,
}: UseStudentPaginationOptions = {}) {
  const [pagination, setPagination] = useState<StudentPagination>({
    currentPage: initialPage,
    pageSize: initialPageSize,
    totalPages: 1,
    totalRecords: 0,
  });

  /**
   * Change current page
   */
  const setPage = useCallback((page: number) => {
    setPagination((prev) => ({
      ...prev,
      currentPage: Math.max(1, page),
    }));
  }, []);

  /**
   * Change page size
   */
  const setPageSize = useCallback((pageSize: number) => {
    setPagination((prev) => ({
      ...prev,
      pageSize,
      currentPage: 1,
    }));
  }, []);

  /**
   * Update server pagination values
   */
  const updatePagination = useCallback(
    (values: Partial<StudentPagination>) => {
      setPagination((prev) => ({
        ...prev,
        ...values,
      }));
    },
    []
  );

  /**
   * Reset pagination
   */
  const resetPagination = useCallback(() => {
    setPagination((prev) => ({
      ...prev,
      currentPage: 1,
    }));
  }, []);

  /**
   * Computed values
   */
  const startRecord = useMemo(() => {
    if (pagination.totalRecords === 0) return 0;

    return (
      (pagination.currentPage - 1) *
        pagination.pageSize +
      1
    );
  }, [pagination]);

  const endRecord = useMemo(() => {
    return Math.min(
      pagination.currentPage *
        pagination.pageSize,
      pagination.totalRecords
    );
  }, [pagination]);

  const hasPrevious = pagination.currentPage > 1;

  const hasNext =
    pagination.currentPage <
    pagination.totalPages;

  return {
    pagination,

    startRecord,
    endRecord,

    hasPrevious,
    hasNext,

    setPage,
    setPageSize,
    updatePagination,
    resetPagination,
  };
}