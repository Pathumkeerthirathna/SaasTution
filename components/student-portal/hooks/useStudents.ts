import { useCallback, useEffect, useState } from "react";
import { StudentRowItem } from "../student-list/StudentRow";
import { StudentFiltersValue } from "../student-list/StudentFilters";



type StudentResponse = {
  data: StudentRowItem[];

  pagination: {
    currentPage: number;
    totalPages: number;
    totalRecords: number;
    pageSize: number;
  };
};

type UseStudentsOptions = {
  endpoint: string;
};

export function useStudents({
  endpoint,
}: UseStudentsOptions) {
  const [students, setStudents] = useState<StudentRowItem[]>([]);

  const [loading, setLoading] = useState(false);

  const [filters, setFilters] =
    useState<StudentFiltersValue>({
      name: "",
      registrationNumber: "",
      gradeId: "",
    });

  const [pagination, setPagination] = useState({
    currentPage: 1,
    totalPages: 1,
    totalRecords: 0,
    pageSize: 10,
  });

  const loadStudents = useCallback(async () => {
    try {
      setLoading(true);

      const params = new URLSearchParams({
        page: pagination.currentPage.toString(),
        pageSize: pagination.pageSize.toString(),

        name: filters.name,

        registrationNumber:
          filters.registrationNumber,

        gradeId: filters.gradeId,
      });

      const response = await fetch(
        `${endpoint}?${params}`
      );

      if (!response.ok)
        throw new Error("Unable to load students.");

      const result: StudentResponse =
        await response.json();

      setStudents(result.data);

      setPagination(result.pagination);
    } finally {
      setLoading(false);
    }
  }, [endpoint, filters, pagination.currentPage, pagination.pageSize]);

  useEffect(() => {
    loadStudents();
  }, [loadStudents]);

  const changePage = (page: number) => {
    setPagination((prev) => ({
      ...prev,
      currentPage: page,
    }));
  };

  const changePageSize = (size: number) => {
    setPagination((prev) => ({
      ...prev,
      pageSize: size,
      currentPage: 1,
    }));
  };

  const search = (value: StudentFiltersValue) => {
    setFilters(value);

    setPagination((prev) => ({
      ...prev,
      currentPage: 1,
    }));
  };

  const refresh = () => {
    loadStudents();
  };

  return {
    students,

    loading,

    filters,

    pagination,

    search,

    refresh,

    changePage,

    changePageSize,
  };
}