"use client";

import { useCallback, useState } from "react";


import { StudentFilters } from "./useStudentFilters";
import { StudentRowItem } from "../student-list/StudentRow";

export type StudentApiResponse = {
  data: StudentRowItem[];

  pagination: {
    currentPage: number;
    totalPages: number;
    totalRecords: number;
    pageSize: number;
  };
};

type GetStudentsRequest = {
  page: number;
  pageSize: number;
  filters?: StudentFilters;
};

type UseStudentApiOptions = {
  endpoint?: string;
};

export function useStudentApi({
  endpoint = "/api/students",
}: UseStudentApiOptions = {}) {
  const [loading, setLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const getStudents = useCallback(
    async ({
      page,
      pageSize,
      filters,
    }: GetStudentsRequest): Promise<StudentApiResponse | null> => {
      try {
        setLoading(true);
        setError(null);

        const params = new URLSearchParams({
          page: page.toString(),
          pageSize: pageSize.toString(),
          name: filters?.name ?? "",
          registrationNumber:
            filters?.registrationNumber ?? "",
          gradeId: filters?.gradeId ?? "",
        });

        const response = await fetch(
          `${endpoint}?${params.toString()}`
        );

        if (!response.ok) {
          throw new Error("Failed to load students.");
        }

        return await response.json();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Something went wrong."
        );

        return null;
      } finally {
        setLoading(false);
      }
    },
    [endpoint]
  );

  const assignStudents = useCallback(
    async (
      classId: string,
      studentIds: string[]
    ): Promise<boolean> => {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch(
          "/api/students/assign",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              classId,
              studentIds,
            }),
          }
        );

        if (!response.ok) {
          throw new Error("Failed to assign students.");
        }

        return true;
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Something went wrong."
        );

        return false;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  return {
    loading,
    error,

    getStudents,

    assignStudents,
  };
}