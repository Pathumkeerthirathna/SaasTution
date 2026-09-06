"use client";

import { Languages, Save, X } from "lucide-react";
import { Medium } from "./medium-types";

interface Props {
  open: boolean;
  saving: boolean;
  mediums: Medium[];
  selectedMediumIds: number[];
  onToggle: (id: number) => void;
  onSave: () => void;
  onClose: () => void;
}

export default function TeacherMediumDrawer({
  open,
  saving,
  mediums,
  selectedMediumIds,
  onToggle,
  onSave,
  onClose,
}: Props) {
  if (!open) return null;

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 z-50 flex h-screen w-full max-w-lg flex-col bg-white shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100">
              <Languages className="h-4 w-4 text-emerald-600" />
            </div>

            <div>
              <h2 className="text-[15px] font-bold text-slate-900">
                Edit Languages
              </h2>

              <p className="text-[12.5px] text-slate-500">
                Select the languages you teach in.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {mediums.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-[13px] text-slate-500">
              No languages available.
            </div>
          ) : (
            <div className="space-y-2">
              {mediums.map((medium) => {
                const checked = selectedMediumIds.includes(medium.id);

                return (
                  <label
                    key={medium.id}
                    className={`flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2.5 transition ${
                      checked
                        ? "border-emerald-400 bg-emerald-50"
                        : "border-slate-200 hover:border-emerald-300 hover:bg-slate-50"
                    }`}
                  >
                    <p className="text-[13px] font-semibold text-slate-800">
                      {medium.name}
                    </p>

                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(medium.id)}
                      className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                    />
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3.5 py-1.5 text-[13px] font-medium text-slate-700 transition hover:bg-white"
          >
            Cancel
          </button>

          <button
            type="button"
            disabled={saving}
            onClick={onSave}
            className="flex items-center gap-1.5 rounded-md bg-[#4D6C90] px-3.5 py-1.5 text-[13px] font-semibold text-white transition hover:bg-[#3B5776] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? "Saving..." : "Save Languages"}
          </button>
        </div>

      </div>
    </>
  );
}
