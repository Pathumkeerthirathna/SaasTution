"use client";

import { useCallback, useMemo, useState } from "react";

type StudentId = string;

export function useStudentSelection(
  initialSelection: StudentId[] = []
) {
  const [selectedIds, setSelectedIds] = useState<Set<StudentId>>(
    () => new Set(initialSelection)
  );

  /**
   * Select / Unselect a student
   */
  const toggleSelection = useCallback(
    (studentId: StudentId) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);

        if (next.has(studentId)) {
          next.delete(studentId);
        } else {
          next.add(studentId);
        }

        return next;
      });
    },
    []
  );

  /**
   * Explicitly set selection state
   */
  const setSelection = useCallback(
    (studentId: StudentId, selected: boolean) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);

        if (selected) {
          next.add(studentId);
        } else {
          next.delete(studentId);
        }

        return next;
      });
    },
    []
  );

  /**
   * Select multiple students
   */
  const selectMany = useCallback((studentIds: StudentId[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);

      studentIds.forEach((id) => next.add(id));

      return next;
    });
  }, []);

  /**
   * Remove multiple students
   */
  const unselectMany = useCallback((studentIds: StudentId[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);

      studentIds.forEach((id) => next.delete(id));

      return next;
    });
  }, []);

  /**
   * Replace selection
   */
  const replaceSelection = useCallback(
    (studentIds: StudentId[]) => {
      setSelectedIds(new Set(studentIds));
    },
    []
  );

  /**
   * Clear selection
   */
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  /**
   * Is selected?
   */
  const isSelected = useCallback(
    (studentId: StudentId) => {
      return selectedIds.has(studentId);
    },
    [selectedIds]
  );

  /**
   * Computed values
   */
  const selectedCount = selectedIds.size;

  const selectedArray = useMemo(
    () => Array.from(selectedIds),
    [selectedIds]
  );

  return {
    selectedIds,

    selectedArray,

    selectedCount,

    isSelected,

    toggleSelection,

    setSelection,

    selectMany,

    unselectMany,

    replaceSelection,

    clearSelection,
  };
}