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

      <div className="fixed right-0 top-0 z-50 flex h-screen w-full max-w-xl flex-col bg-white shadow-2xl">

        {/* Header */}

        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-5">

          <div className="flex items-center gap-3">

            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-100">

              <Trophy className="h-6 w-6 text-orange-600" />

            </div>

            <div>

              <h2 className="text-[22px] font-bold text-slate-900">
                {initialValue
                  ? "Edit Achievement"
                  : "Add Achievement"}
              </h2>

              <p className="text-[16px] text-slate-500">
                Showcase awards, recognitions and
                milestones achieved throughout your
                teaching career.
              </p>

            </div>

          </div>

          <button
            onClick={onClose}
            className="rounded-lg p-2 transition hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>

        </div>

        {/* Body */}

        <div className="flex-1 overflow-y-auto p-6">

          <div className="space-y-6">

            {/* Title */}

            <div>

              <label className="mb-2 block text-[16px] font-semibold text-slate-700">
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
                className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-orange-500"
              />

            </div>

            {/* Year */}

            <div>

              <label className="mb-2 block text-[16px] font-semibold text-slate-700">
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
                className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-orange-500"
              />

            </div>

            {/* Description */}

            <div>

              <label className="mb-2 block text-[16px] font-semibold text-slate-700">
                Description
              </label>

              <textarea
                rows={6}
                value={form.description}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    description: e.target.value,
                  }))
                }
                placeholder="Describe this achievement, award or recognition..."
                className="w-full resize-none rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-orange-500"
              />

            </div>

            {/* Information */}

            <div className="rounded-2xl border border-orange-100 bg-gradient-to-r from-orange-50 to-amber-50 p-5">

              <div className="flex items-start gap-3">

                <Award className="mt-0.5 h-5 w-5 text-orange-600" />

                <div>

                  <h4 className="font-semibold text-slate-900">
                    Professional Tip
                  </h4>

                  <p className="mt-2 text-[16px] leading-6 text-slate-600">
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

        <div className="flex justify-end gap-3 border-t border-slate-200 bg-slate-50 px-6 py-5">

          <button
            onClick={onClose}
            className="rounded-xl border border-slate-300 px-5 py-2.5 font-medium text-slate-700 transition hover:bg-white"
          >
            Cancel
          </button>

          <button
            disabled={saving}
            onClick={submit}
            className="flex items-center gap-2 rounded-xl bg-orange-500 px-6 py-2.5 font-semibold text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save className="h-4 w-4" />

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