"use client";

import { RefreshCw, Plus, Download } from "lucide-react";

type StudentToolbarProps = {
  title?: string;
  subtitle?: string;

  selectedCount?: number;

  loading?: boolean;

  showRefresh?: boolean;
  showExport?: boolean;
  showAddButton?: boolean;

  addButtonText?: string;

  onRefresh?: () => void;
  onExport?: () => void;
  onAdd?: () => void;

  children?: React.ReactNode;
};

export default function StudentToolbar({
  title = "Students",
  subtitle,

  selectedCount = 0,

  loading = false,

  showRefresh = true,
  showExport = false,
  showAddButton = false,

  addButtonText = "Add",

  onRefresh,
  onExport,
  onAdd,

  children,
}: StudentToolbarProps) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">

        {/* Left */}
        <div className="space-y-1">
          <h2 className="text-xl font-bold text-slate-900">
            {title}
          </h2>

          {subtitle && (
            <p className="text-sm text-slate-500">
              {subtitle}
            </p>
          )}

          {selectedCount > 0 && (
            <span className="inline-flex rounded-full bg-blue-100 px-3 py-1 text-xs font-semibold text-blue-700">
              {selectedCount} Selected
            </span>
          )}
        </div>

        {/* Right */}
        <div className="flex flex-wrap items-center justify-end gap-2">

          {children}

          {showRefresh && (
            <button
              onClick={onRefresh}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw
                size={16}
                className={loading ? "animate-spin" : ""}
              />
              Refresh
            </button>
          )}

          {showExport && (
            <button
              onClick={onExport}
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-100"
            >
              <Download size={16} />
              Export
            </button>
          )}

          {showAddButton && (
            <button
              onClick={onAdd}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700"
            >
              <Plus size={16} />
              {addButtonText}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}