"use client";

import { useEffect, useState } from "react";
import {
  BookOpen,
  Save,
  X,
} from "lucide-react";

import {
  Subject,
  SubjectForm,
  TEACHING_LEVELS,
  TEACHING_LEVEL_LABELS,
  TeachingLevel,
  TeacherSubject,
} from "@/types/teacherProfileTypes/teacherSubjects/teacherSubjectTypes";

interface Props {
  open: boolean;
  saving: boolean;

  editingSubject?: TeacherSubject | null;

  onClose: () => void;

  onSave: (
    form: SubjectForm
  ) => void;
}

export default function SubjectDrawer({
  open,
  saving,
  editingSubject,
  onClose,
  onSave,
}: Props) {
  const [subjects, setSubjects] =
    useState<Subject[]>([]);

  const [form, setForm] =
    useState<SubjectForm>({
      subjectId: 0,
      levels: [],
    });

  const [loading, setLoading] =
    useState(false);

  useEffect(() => {
  if (!open) return;

  async function loadSubjects() {
    try {
      setLoading(true);

      const response = await fetch(
        "/api/teacher/master/subjects"
      );

      if (!response.ok) {
        throw new Error();
      }

      const data = await response.json();

      setSubjects(data);

      if (!editingSubject && data.length > 0) {
        setForm((prev) => ({
          ...prev,
          subjectId: data[0].id,
        }));
      }
    } finally {
      setLoading(false);
    }
  }

  loadSubjects();
}, [open, editingSubject]);

  useEffect(() => {
    if (!open) return;

    if (editingSubject) {
      setForm({
        subjectId: editingSubject.subjectId,
        levels: editingSubject.levels,
      });
    } else {
      setForm({
        subjectId: 0,
        levels: [],
      });
    }
  }, [editingSubject, open]);

  function toggleLevel(level: TeachingLevel) {
    setForm((prev) => ({
      ...prev,
      levels: prev.levels.includes(level)
        ? prev.levels.filter((item) => item !== level)
        : [...prev.levels, level],
    }));
  }


  if (!open) return null;

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

            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100">
              <BookOpen className="h-4 w-4 text-emerald-600" />
            </div>

            <div>

              <h2 className="text-[15px] font-bold text-slate-900">
                {editingSubject
                  ? "Edit Subject"
                  : "Add Subject"}
              </h2>

              <p className="text-[12.5px] text-slate-500">
                Configure the subjects you teach.
              </p>

            </div>

          </div>

          <button
            onClick={onClose}
            className="rounded-md p-1.5 hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>

        </div>

        {/* Body */}

        <div className="flex-1 overflow-y-auto p-5">

          {loading ? (

            <p className="text-[13px] text-slate-500">
              Loading...
            </p>

          ) : (

            <div className="space-y-4">

              {/* Subject */}

              <div>

                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  Subject
                </label>

                <select
                  value={form.subjectId}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      subjectId: Number(
                        e.target.value
                      ),
                    })
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-emerald-500"
                >
                  {subjects.map((subject) => (
                    <option
                      key={subject.id}
                      value={subject.id}
                    >
                      {subject.name}
                    </option>
                  ))}
                </select>

              </div>

              {/* Teaching levels */}

              <div>

                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  Teaching Levels
                </label>

                <div className="grid grid-cols-3 gap-2">

                  {TEACHING_LEVELS.map((level) => {
                    const checked = form.levels.includes(level);

                    return (
                      <label
                        key={level}
                        className={`flex cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 py-2 text-[13px] font-medium transition ${
                          checked
                            ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                            : "border-slate-300 text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleLevel(level)}
                          className="h-3.5 w-3.5 accent-emerald-600"
                        />

                        {TEACHING_LEVEL_LABELS[level]}
                      </label>
                    );
                  })}

                </div>

                <p className="mt-1.5 text-[12px] text-slate-500">
                  Choose every level you teach this subject for.
                </p>

              </div>

            </div>

          )}

        </div>

        {/* Footer */}

        <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3.5">

          <button
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3.5 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-white"
          >
            Cancel
          </button>

          <button
            disabled={
              saving ||
              !form.subjectId ||
              form.levels.length === 0
            }
            onClick={() =>
              onSave(form)
            }
            className="flex items-center gap-1.5 rounded-md bg-[#4D6C90] px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-[#3B5776] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save className="h-3.5 w-3.5" />

            {saving
              ? "Saving..."
              : editingSubject
              ? "Update Subject"
              : "Add Subject"}
          </button>

        </div>

      </div>
    </>
  );
}
