"use client";

import { useEffect, useState } from "react";
import { GraduationCap, Save, X } from "lucide-react";
import { QualificationForm, TeacherQualification } from "./qualification-types";

interface Props {
  open: boolean;
  qualification: TeacherQualification | null;
  saving: boolean;
  onClose: () => void;
  onSave: (form: QualificationForm) => void;
}

export default function QualificationDrawer({
  open,
  qualification,
  saving,
  onClose,
  onSave,
}: Props) {
  const [form, setForm] = useState<QualificationForm>({
    title: "",
    institute: "",
    startYear: null,
    endYear: null,
    displayOrder: 0,
  });

  useEffect(() => {
    if (qualification) {
      setForm({
        title: qualification.title,
        institute: qualification.institute,
        startYear: qualification.startYear,
        endYear: qualification.endYear,
        displayOrder: qualification.displayOrder,
      });
    } else {
      setForm({
        title: "",
        institute: "",
        startYear: null,
        endYear: null,
        displayOrder: 0,
      });
    }
  }, [qualification, open]);

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
              <GraduationCap className="h-4 w-4 text-emerald-600" />
            </div>

            <div>
              <h2 className="text-[15px] font-bold text-slate-900">
                {qualification ? "Edit Qualification" : "Add Qualification"}
              </h2>

              <p className="text-[12.5px] text-slate-500">
                Your academic and professional educational background.
              </p>
            </div>

          </div>

          <button
            onClick={onClose}
            className="rounded-md p-1.5 transition hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>

        </div>

        {/* Body */}

        <div className="flex-1 overflow-y-auto p-5">

          <div className="space-y-4">

            {/* Qualification */}

            <div>

              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Qualification *
              </label>

              <input
                value={form.title}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    title: e.target.value,
                  }))
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none transition focus:border-emerald-500"
                placeholder="BSc (Hons) Mathematics"
              />

            </div>

            {/* Institute */}

            <div>

              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Institute *
              </label>

              <input
                value={form.institute}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    institute: e.target.value,
                  }))
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none transition focus:border-emerald-500"
                placeholder="University of Colombo"
              />

            </div>

            {/* Years */}

            <div className="grid grid-cols-2 gap-3">

              <div>

                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  Start Year
                </label>

                <input
                  type="number"
                  value={form.startYear ?? ""}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      startYear: e.target.value
                        ? Number(e.target.value)
                        : null,
                    }))
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none transition focus:border-emerald-500"
                  placeholder="2018"
                />

              </div>

              <div>

                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  End Year
                </label>

                <input
                  type="number"
                  value={form.endYear ?? ""}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      endYear: e.target.value
                        ? Number(e.target.value)
                        : null,
                    }))
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none transition focus:border-emerald-500"
                  placeholder="2022"
                />

              </div>

            </div>

            {/* Display Order */}

            <div>

              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Display Order
              </label>

              <input
                type="number"
                value={form.displayOrder}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    displayOrder: Number(e.target.value),
                  }))
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none transition focus:border-emerald-500"
              />

              <p className="mt-1.5 text-[12px] text-slate-500">
                Higher priority qualifications can be displayed first by using
                display order.
              </p>

            </div>

          </div>

        </div>

        {/* Footer */}

        <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3.5">

          <button
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3.5 py-1.5 text-[13px] font-medium text-slate-700 transition hover:bg-white"
          >
            Cancel
          </button>

          <button
            disabled={
              saving ||
              !form.title.trim() ||
              !form.institute.trim()
            }
            onClick={() => onSave(form)}
            className="flex items-center gap-1.5 rounded-md bg-[#4D6C90] px-3.5 py-1.5 text-[13px] font-semibold text-white transition hover:bg-[#3B5776] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save className="h-3.5 w-3.5" />

            {saving
              ? "Saving..."
              : qualification
              ? "Update Qualification"
              : "Save Qualification"}
          </button>

        </div>

      </div>
    </>
  );
}
