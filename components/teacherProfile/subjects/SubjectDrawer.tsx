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

const grades = Array.from(
  { length: 13 },
  (_, i) => i + 1
);

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
      gradeFrom: 6,
      gradeTo: 11,
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

      const data =
        await response.json();

        console.log(data);

      setSubjects(data);

      if (
        !editingSubject &&
        data.length > 0
      ) {
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
    
  }, [open]);

  useEffect(() => {
    if (!open) return;

    if (editingSubject) {
      setForm({
        subjectId: editingSubject.subjectId,
        gradeFrom: editingSubject.gradeFrom,
        gradeTo: editingSubject.gradeTo,
      });
    } else {
      setForm({
        subjectId: 0,
        gradeFrom: 6,
        gradeTo: 11,
      });
    }
  }, [editingSubject, open]);

  

  if (!open) return null;

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

            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-100">
              <BookOpen className="h-6 w-6 text-emerald-600" />
            </div>

            <div>

              <h2 className="text-xl font-bold text-slate-900">
                {editingSubject
                  ? "Edit Subject"
                  : "Add Subject"}
              </h2>

              <p className="text-sm text-slate-500">
                Configure the subjects you teach.
              </p>

            </div>

          </div>

          <button
            onClick={onClose}
            className="rounded-lg p-2 hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>

        </div>

        {/* Body */}

        <div className="flex-1 overflow-y-auto p-6">

          {loading ? (

            <p className="text-slate-500">
              Loading...
            </p>

          ) : (

            <div className="space-y-6">

              {/* Subject */}

              <div>

                <label className="mb-2 block text-sm font-semibold text-slate-700">
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
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-emerald-500"
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

              {/* Grades */}

              <div className="grid grid-cols-2 gap-5">

                <div>

                  <label className="mb-2 block text-sm font-semibold text-slate-700">
                    Grade From
                  </label>

                  <select
                    value={form.gradeFrom}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        gradeFrom: Number(
                          e.target.value
                        ),
                      })
                    }
                    className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-emerald-500"
                  >
                    {grades.map((grade) => (
                      <option
                        key={grade}
                        value={grade}
                      >
                        Grade {grade}
                      </option>
                    ))}
                  </select>

                </div>

                <div>

                  <label className="mb-2 block text-sm font-semibold text-slate-700">
                    Grade To
                  </label>

                  <select
                    value={form.gradeTo}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        gradeTo: Number(
                          e.target.value
                        ),
                      })
                    }
                    className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-emerald-500"
                  >
                    {grades.map((grade) => (
                      <option
                        key={grade}
                        value={grade}
                      >
                        Grade {grade}
                      </option>
                    ))}
                  </select>

                </div>

              </div>

              {form.gradeTo <
                form.gradeFrom && (

                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                  Grade To cannot be less than Grade From.
                </div>

              )}

            </div>

          )}

        </div>

        {/* Footer */}

        <div className="flex justify-end gap-3 border-t border-slate-200 bg-slate-50 px-6 py-5">

          <button
            onClick={onClose}
            className="rounded-xl border border-slate-300 px-5 py-2.5 font-medium text-slate-700 hover:bg-white"
          >
            Cancel
          </button>

          <button
            disabled={
              saving ||
              form.gradeTo <
                form.gradeFrom
            }
            onClick={() =>
              onSave(form)
            }
            className="flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-2.5 font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save className="h-4 w-4" />

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