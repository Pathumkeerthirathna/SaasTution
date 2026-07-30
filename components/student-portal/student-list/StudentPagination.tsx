"use client";

import {
  ChevronsLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
} from "lucide-react";

type StudentPaginationProps = {
  currentPage: number;
  totalPages: number;
  totalRecords: number;
  pageSize: number;

  pageSizeOptions?: number[];

  loading?: boolean;

  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
};

export default function StudentPagination({
  currentPage,
  totalPages,
  totalRecords,
  pageSize,
  pageSizeOptions = [10, 20, 50, 100],
  loading = false,
  onPageChange,
  onPageSizeChange,
}: StudentPaginationProps) {
  const start =
    totalRecords === 0 ? 0 : (currentPage - 1) * pageSize + 1;

  const end = Math.min(currentPage * pageSize, totalRecords);

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
      {/* Left */}
      <div className="text-sm text-slate-600">
        Showing{" "}
        <span className="font-semibold text-slate-900">
          {start}
        </span>{" "}
        to{" "}
        <span className="font-semibold text-slate-900">
          {end}
        </span>{" "}
        of{" "}
        <span className="font-semibold text-slate-900">
          {totalRecords}
        </span>{" "}
        records
      </div>

      {/* Right */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {/* Page Size */}
        {onPageSizeChange && (
          <div className="flex items-center gap-2">
            <label className="text-sm text-slate-600">
              Rows
            </label>

            <select
              value={pageSize}
              disabled={loading}
              onChange={(e) =>
                onPageSizeChange(Number(e.target.value))
              }
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
            >
              {pageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Navigation */}
        <div className="flex items-center justify-center gap-2">
          <button
            disabled={loading || currentPage === 1}
            onClick={() => onPageChange(1)}
            className="rounded-lg border border-slate-300 p-2 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChevronsLeft size={18} />
          </button>

          <button
            disabled={loading || currentPage === 1}
            onClick={() => onPageChange(currentPage - 1)}
            className="rounded-lg border border-slate-300 p-2 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChevronLeft size={18} />
          </button>

          <div className="min-w-[110px] rounded-lg bg-slate-100 px-4 py-2 text-center text-sm font-medium text-slate-700">
            {currentPage} / {totalPages}
          </div>

          <button
            disabled={loading || currentPage === totalPages}
            onClick={() => onPageChange(currentPage + 1)}
            className="rounded-lg border border-slate-300 p-2 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChevronRight size={18} />
          </button>

          <button
            disabled={loading || currentPage === totalPages}
            onClick={() => onPageChange(totalPages)}
            className="rounded-lg border border-slate-300 p-2 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChevronsRight size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}