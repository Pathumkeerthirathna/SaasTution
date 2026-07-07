"use client";

import { SubjectForm, TeacherSubject } from "@/types/teacherProfileTypes/teacherSubjects/teacherSubjectTypes";
import { TeacherProfileSubject } from "@prisma/client";
import {
  BookOpen,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import SubjectDrawer from "./subjects/SubjectDrawer";

interface Props {
  teacherId:string;
  isPublic?: boolean;
}

export default function TeacherSubjectsCard({
  teacherId,
  isPublic
}: Props) {
 

  useEffect(() => {
    setLoading(true);
      loadSubjects();
  }, []);

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

      await loadSubjects();

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

      await loadSubjects();

      setDeleting(false);

  }

  if (loading) {
  return (
    <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 shadow-sm animate-pulse">
      <div className="flex flex-col gap-6 lg:flex-row lg:justify-between">

        {/* Left */}
        <div className="flex gap-5">

          {/* Avatar */}
          <div className="h-28 w-28 rounded-full bg-slate-200" />

          {/* Details */}
          <div className="space-y-4">
            <div className="h-8 w-64 rounded bg-slate-200" />
            <div className="h-5 w-48 rounded bg-slate-200" />
            <div className="h-4 w-72 rounded bg-slate-200" />
            <div className="h-4 w-56 rounded bg-slate-200" />

            <div className="flex gap-4">
              <div className="h-4 w-32 rounded bg-slate-200" />
              <div className="h-4 w-32 rounded bg-slate-200" />
            </div>
          </div>
        </div>

        {/* Right */}
        <div className="space-y-4">
          <div className="h-11 w-40 rounded-xl bg-slate-200" />
          <div className="h-4 w-24 rounded bg-slate-200" />

          <div className="flex gap-2">
            <div className="h-8 w-20 rounded-full bg-slate-200" />
            <div className="h-8 w-20 rounded-full bg-slate-200" />
            <div className="h-8 w-20 rounded-full bg-slate-200" />
          </div>
        </div>

      </div>
    </div>
  );
}

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
        <div>
          <h3 className="text-lg font-bold text-slate-900">
            Subjects & Grade Levels
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            Subjects currently taught by this
            teacher.
          </p>
        </div>

        {isPublic ? null : (
          
          <button
            onClick={openAddDrawer}
            disabled={saving || deleting}
            className="flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
            {(saving || deleting) && (
              <svg
                className="h-4 w-4 animate-spin"
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
                  <Plus className="h-4 w-4" />
                  <span>Manage Subjects</span>
                </>
              )}
            </button>
      
      )}

        
      </div>

      {/* Body */}
      <div className="p-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {subjects.map((subject) => (
            <div
              key={subject.id}
              className="group rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-emerald-200 hover:shadow-md"
            >
              <div className="flex items-start justify-between">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-100">
                  <BookOpen className="h-6 w-6 text-emerald-600" />
                </div>

                {isPublic ? null : (<div className="flex items-center gap-2">
                  <button
                    className="rounded-lg border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50"
                    title="Edit Subject"
                      onClick={() =>
                          openEditDrawer(subject)
                      }
                  >
                    <Pencil className="h-4 w-4" />
                  </button>

                  <button
                    className="rounded-lg border border-red-200 p-2 text-red-500 transition hover:bg-red-50"
                    title="Delete Subject"
                    onClick={()=>deleteSubject(subject.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>)}

                



              </div>

              <h4 className="mt-4 text-lg font-bold text-slate-900">
                {subject.subject.name}
              </h4>

              <div className="mt-3 inline-flex rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-700">
                Grade {subject.gradeFrom} -{" "}
                Grade {subject.gradeTo}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {/* {subject.mediums.map((medium) => (
                  <span
                    key={medium}
                    className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700"
                  >
                    {medium}
                  </span>
                ))} */}
              </div>
            </div>
          ))}
        </div>

        {/* Summary */}
        <div className="mt-6 rounded-2xl border border-emerald-100 bg-gradient-to-r from-emerald-50 to-orange-50 p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-100">
              <BookOpen className="h-6 w-6 text-emerald-600" />
            </div>

            <div>
              <p className="text-sm text-slate-500">
                Total Subjects
              </p>

              <h4 className="text-xl font-bold text-slate-900">
                {subjects.length}
              </h4>
            </div>
          </div>

          <p className="mt-4 text-sm leading-6 text-slate-700">
            Subjects and grade levels displayed
            here will be visible to students and
            parents on your public profile.
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

