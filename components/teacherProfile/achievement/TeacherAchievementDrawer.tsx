"use client";

import { useEffect, useState } from "react";
import { Award, Save, Trophy, X } from "lucide-react";
import { AchievementForm } from "@/types/teacherProfileTypes/achievement/achievement-types";

interface Props {
  open: boolean;

  saving: boolean;

  initialValue?: AchievementForm;

  onSave: (form: AchievementForm) => void;

  onClose: () => void;
}

const emptyForm: AchievementForm = {
  title: "",
  description: "",
  year: "",
};

export default function TeacherAchievementDrawer({
  open,
  saving,
  initialValue,
  onSave,
  onClose,
}: Props) {
  const [form, setForm] =
    useState<AchievementForm>(emptyForm);

  useEffect(() => {
    if (!open) return;

    setForm(
      initialValue ?? emptyForm
    );
  }, [open, initialValue]);

  if (!open) return null;

  function submit() {
    if (!form.title.trim()) {
      alert("Achievement title is required.");
      return;
    }

    onSave(form);
  }

  return (
    <>
      {/* Overlay */}

      <div
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
      />

      {/* Drawer */}

      <div className="fixed right-0 top-0 z-50 flex h-screen w-full max-w-lg flex-col bg-white shadow-2xl">

        {/* Header */}

        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">

          <div className="flex items-center gap-2.5">

            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-100">

              <Trophy className="h-4 w-4 text-orange-600" />

            </div>

            <div>

              <h2 className="text-[15px] font-bold text-slate-900">
                {initialValue
                  ? "Edit Achievement"
                  : "Add Achievement"}
              </h2>

              <p className="text-[12.5px] text-slate-500">
                Showcase awards, recognitions and milestones from your teaching career.
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

            {/* Title */}

            <div>

              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Achievement Title
              </label>

              <input
                value={form.title}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    title: e.target.value,
                  }))
                }
                placeholder="Best Mathematics Teacher Award"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none transition focus:border-orange-500"
              />

            </div>

            {/* Year */}

            <div>

              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Achievement Year
              </label>

              <input
                type="number"
                min={1900}
                max={2100}
                value={form.year}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    year: e.target.value
                      ? Number(e.target.value)
                      : "",
                  }))
                }
                placeholder="2025"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none transition focus:border-orange-500"
              />

            </div>

            {/* Description */}

            <div>

              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Description
              </label>

              <textarea
                rows={5}
                value={form.description}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    description: e.target.value,
                  }))
                }
                placeholder="Describe this achievement, award or recognition..."
                className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none transition focus:border-orange-500"
              />

            </div>

            {/* Information */}

            <div className="rounded-lg border border-orange-100 bg-gradient-to-r from-orange-50 to-amber-50 p-3.5">

              <div className="flex items-start gap-2.5">

                <Award className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" />

                <div>

                  <h4 className="text-[13px] font-semibold text-slate-900">
                    Professional Tip
                  </h4>

                  <p className="mt-1 text-[12.5px] leading-5 text-slate-600">
                    Add awards, competition victories,
                    teaching recognitions, university
                    achievements or outstanding student
                    result milestones to increase your
                    credibility with students and
                    parents.
                  </p>

                </div>

              </div>

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
            disabled={saving}
            onClick={submit}
            className="flex items-center gap-1.5 rounded-md bg-[#4D6C90] px-3.5 py-1.5 text-[13px] font-semibold text-white transition hover:bg-[#3B5776] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save className="h-3.5 w-3.5" />

            {saving
              ? "Saving..."
              : initialValue
              ? "Update Achievement"
              : "Add Achievement"}
          </button>

        </div>

      </div>
    </>
  );
}
