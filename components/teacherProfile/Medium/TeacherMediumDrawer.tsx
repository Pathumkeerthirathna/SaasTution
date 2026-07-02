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
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-100">
              <Languages className="h-6 w-6 text-emerald-600" />
            </div>

            <div>
              <h2 className="text-xl font-bold text-slate-900">
                Teaching Mediums
              </h2>

              <p className="text-sm text-slate-500">
                Select the languages you teach in.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 transition hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">

          {mediums.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
              No teaching mediums available.
            </div>
          ) : (
            <div className="space-y-3">

              {mediums.map((medium) => {

                const checked = selectedMediumIds.includes(
                  medium.id
                );

                return (
                  <label
                    key={medium.id}
                    className={`flex cursor-pointer items-center justify-between rounded-2xl border p-4 transition ${
                      checked
                        ? "border-emerald-500 bg-emerald-50"
                        : "border-slate-200 hover:border-emerald-300 hover:bg-slate-50"
                    }`}
                  >
                    <div>
                      <p className="font-semibold text-slate-800">
                        {medium.name}
                      </p>

                      <p className="mt-1 text-xs text-slate-500">
                        Students will see this on your public profile.
                      </p>
                    </div>

                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(medium.id)}
                      className="h-5 w-5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                    />
                  </label>
                );
              })}

            </div>
          )}

        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 border-t border-slate-200 bg-slate-50 px-6 py-5">

          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-300 px-5 py-2.5 font-medium text-slate-700 transition hover:bg-white"
          >
            Cancel
          </button>

          <button
            type="button"
            disabled={saving}
            onClick={onSave}
            className="flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-2.5 font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save className="h-4 w-4" />

            {saving ? "Saving..." : "Save Mediums"}
          </button>

        </div>

      </div>
    </>
  );
}