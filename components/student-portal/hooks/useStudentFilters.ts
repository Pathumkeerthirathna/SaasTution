"use client";

import { useCallback, useState } from "react";

export type StudentFilters = {
  name: string;
  registrationNumber: string;
  gradeId: string;
};

const defaultFilters: StudentFilters = {
  name: "",
  registrationNumber: "",
  gradeId: "",
};

export function useStudentFilters(
  initialFilters: Partial<StudentFilters> = {}
) {
  const [filters, setFilters] = useState<StudentFilters>({
    ...defaultFilters,
    ...initialFilters,
  });

  /**
   * Update a single filter
   */
  const updateFilter = useCallback(
    <K extends keyof StudentFilters>(
      key: K,
      value: StudentFilters[K]
    ) => {
      setFilters((prev) => ({
        ...prev,
        [key]: value,
      }));
    },
    []
  );

  /**
   * Update multiple filters
   */
  const updateFilters = useCallback(
    (values: Partial<StudentFilters>) => {
      setFilters((prev) => ({
        ...prev,
        ...values,
      }));
    },
    []
  );

  /**
   * Reset filters
   */
  const resetFilters = useCallback(() => {
    setFilters(defaultFilters);
  }, []);

  /**
   * Returns true if any filter has a value
   */
  const hasFilters = Object.values(filters).some(
    (value) => value !== ""
  );

  return {
    filters,

    hasFilters,

    setFilters,

    updateFilter,

    updateFilters,

    resetFilters,
  };
}