"use client";

import { SubjectForm, TeacherSubject } from "@/types/teacherProfileTypes/teacherSubjects/teacherSubjectTypes";
import {
  BookOpen,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import SubjectDrawer from "./subjects/SubjectDrawer";
import SectionVisibilityToggle from "./SectionVisibilityToggle";

interface Props {
  teacherId:string;
  isPublic?: boolean;
  sectionVisible?: boolean;
}

export default function TeacherSubjectsCard({
  teacherId,
  isPublic,
  sectionVisible = true
}: Props) {

  const [visible, setVisible] = useState(sectionVisible);


  useEffect(() => {
    setLoading(true);
    async function loadSubjects() {

      console.log(teacherId);

        const res = await fetch(
            `/api/teacher/profile/subjects?teacherId=${teacherId}`
        );

        const data = await res.json();

        console.log(data);

        setSubjects(data);

        setLoading(false);
    }
      loadSubjects();
  }, []);

  async function RefreshSubjects() {

    console.log(teacherId);

      const res = await fetch(
          `/api/teacher/profile/subjects?teacherId=${teacherId}`
      );

      const data = await res.json();

      console.log(data);

      setSubjects(data);

      setLoading(false);
  }

  const [subjects, setSubjects] =
    useState<TeacherSubject[]>([]);

  const [drawerOpen, setDrawerOpen] =
      useState(false);

  const [editingSubject,
  setEditingSubject] =
  useState<TeacherSubject | null>(null);

  const [saving, setSaving] =
  useState(false);

    const [deleting, setDeleting] = useState(false);

  const [loading, setLoading] =
  useState(true);

  

  function openAddDrawer() {

      setEditingSubject(null);

      setDrawerOpen(true);

  }

  function openEditDrawer(
      subject: TeacherSubject
  ) {

      setEditingSubject(subject);

      setDrawerOpen(true);

  }

  async function saveSubject(
      form: SubjectForm
  ) {

    setSaving(true);

      const editing =
          editingSubject != null;

      const url = editing
          ? `/api/teacher/profile/subjects/${editingSubject.id}`
          : "/api/teacher/profile/subjects";

      const method =
          editing ? "PUT" : "POST";

      await fetch(url,{
          method,
          headers:{
              "Content-Type":"application/json"
          },
          body:JSON.stringify(form)
      });

      setDrawerOpen(false);

      await RefreshSubjects();

      setSaving(false);

  }

  async function deleteSubject(
      id:string
  ){

      if(!confirm("Delete subject?"))
          return;

      setDeleting(true);

      await fetch(
          `/api/teacher/profile/subjects/${id}`,
          {
              method:"DELETE"
          }
      );

      await RefreshSubjects();

      setDeleting(false);

  }

  // Hidden from public visitors when the teacher has switched the section off.
  if (isPublic && !visible) {
    return null;
  }

  if (loading) {
  return (
    <div className="animate-pulse overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
        <div className="space-y-1.5">
          <div className="h-4 w-36 rounded bg-slate-200" />
          <div className="h-3 w-44 rounded bg-slate-200" />
        </div>
        <div className="h-7 w-24 rounded-lg bg-slate-200" />
      </div>

      <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2">
        <div className="h-24 rounded-lg bg-slate-100" />
        <div className="h-24 rounded-lg bg-slate-100" />
      </div>
    </div>
  );
}

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
        <div>
          <h3 className="text-[16px] font-bold text-slate-900">
            Subjects &amp; Grade Levels
          </h3>

          <p className="mt-0.5 text-[14px] text-slate-500">
            Subjects currently taught by this teacher.
          </p>
        </div>

        {isPublic ? null : (
          <div className="flex shrink-0 items-center gap-2">
          <SectionVisibilityToggle
            section="subjects"
            initialVisible={visible}
            onChange={setVisible}
          />
          <button
            onClick={openAddDrawer}
            disabled={saving || deleting}
            className="inline-flex items-center gap-1 rounded-md bg-[#4D6C90] px-2.5 py-1 text-[12.5px] font-medium text-white transition hover:bg-[#3B5776] disabled:cursor-not-allowed disabled:opacity-60"
            >
            {(saving || deleting) && (
              <svg
                className="h-3.5 w-3.5 animate-spin"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                />
              </svg>
            )}

            {saving
              ? "Saving..."
              : deleting
              ? "Deleting..."
              : (
                <>
                  <Plus className="h-3.5 w-3.5" />
                  <span>Manage</span>
                </>
              )}
            </button>
          </div>
      )}
      </div>

      {/* Body */}
      <div className="p-5">
        {subjects.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 p-5 text-center text-[14px] text-slate-500">
            No subjects added yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {subjects.map((subject) => (
              <div
                key={subject.id}
                className="group rounded-lg border border-slate-200 bg-white p-3 transition hover:border-emerald-200 hover:shadow-sm"
              >
                <div className="flex items-start justify-between">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100">
                    <BookOpen className="h-4 w-4 text-emerald-600" />
                  </div>

                  {isPublic ? null : (
                    <div className="flex items-center gap-0.5">
                      <button
                        className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                        title="Edit Subject"
                        onClick={() => openEditDrawer(subject)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>

                      <button
                        className="rounded-md p-1 text-red-400 transition hover:bg-red-50 hover:text-red-600"
                        title="Delete Subject"
                        onClick={() => deleteSubject(subject.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                <h4 className="mt-2 break-words text-[15px] font-semibold text-slate-900 sm:truncate">
                  {subject.subject.name}
                </h4>

                <div className="mt-1.5 inline-flex rounded-full bg-orange-100 px-2 py-0.5 text-[12px] font-semibold text-orange-700">
                  Grade {subject.gradeFrom} - {subject.gradeTo}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Summary */}
        <div className="mt-4 rounded-xl border border-emerald-100 bg-gradient-to-r from-emerald-50 to-orange-50 p-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100">
              <BookOpen className="h-4 w-4 text-emerald-600" />
            </div>

            <div>
              <p className="text-[13px] text-slate-500">
                Total Subjects
              </p>

              <h4 className="text-[18px] font-bold leading-tight text-slate-900">
                {subjects.length}
              </h4>
            </div>
          </div>

          <p className="mt-2 text-[14px] leading-5 text-slate-700">
            Subjects and grade levels shown here are visible to students and parents on your public profile.
          </p>
        </div>
      </div>

        <SubjectDrawer
            open={drawerOpen}
            saving={saving}
            editingSubject={editingSubject}
            onClose={()=>{
                setDrawerOpen(false);
                setEditingSubject(null);
            }}
            onSave={saveSubject}
        />

    </div>
  );
}

