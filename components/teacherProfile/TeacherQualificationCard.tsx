"use client";

import { TeacherQualification } from "@prisma/client";
import {
  GraduationCap,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { QualificationForm } from "./qualification/qualification-types";
import QualificationDrawer from "./qualification/QualificationDrawer";

interface Props {
  teacherId:string;
  isPublic?: boolean;
}

export default function TeacherQualificationCard({
  teacherId,
  isPublic
}:Props) {


  const [qualifications, setQualifications] = useState<
    TeacherQualification[]
  >([]);

  const [loading, setLoading] = useState(true);

  const [drawerOpen, setDrawerOpen] =
    useState(false);

  const [editingQualification,
      setEditingQualification] =
  useState<TeacherQualification | null>(null);

  const [saving, setSaving] =
  useState(false);

  useEffect(() => {

    async function loadQualifications() {
      try {
        const res = await fetch(
          `/api/teacher/profile/qualifications?teacherId=${teacherId}`
        );

        if (!res.ok)
          throw new Error("Failed to load qualifications");

        const data = await res.json();

        setQualifications(data);
      } finally {
        setLoading(false);
      }
    }

    loadQualifications();

  }, []);


  async function RefreshQualifications() {
      try {
        const res = await fetch(
          `/api/teacher/profile/qualifications?teacherId=${teacherId}`
        );

        if (!res.ok)
          throw new Error("Failed to load qualifications");

        const data = await res.json();

        setQualifications(data);
      } finally {
        setLoading(false);
      }
    }
  

  function openAddDrawer() {

      setEditingQualification(null);

      setDrawerOpen(true);

  }

  function openEditDrawer(
    qualification: TeacherQualification
  ) {

      setEditingQualification(
          qualification
      );

      setDrawerOpen(true);

  }

  async function saveQualification(
  form: QualificationForm
  ) {

      setSaving(true);

      try {

          const editing =
              editingQualification != null;

          const url = editing
              ? `/api/teacher/profile/qualifications/${editingQualification.id}`
              : "/api/teacher/profile/qualifications";

          const method =
              editing ? "PUT" : "POST";

          const response =
              await fetch(url,{

                  method,

                  headers:{
                      "Content-Type":
                      "application/json"
                  },

                  body:JSON.stringify(form)

              });

          if(!response.ok){

              const error =
              await response.json();

              throw new Error(
                  error.message
              );

          }

          alert(
              editing
                  ? "Qualification updated successfully."
                  : "Qualification added successfully."
          );

          setDrawerOpen(false);

          setEditingQualification(
              null
          );

          await RefreshQualifications();

      }
      finally{

          setSaving(false);

      }

  }

  async function deleteQualification(
    id:string
    ){

        if(
    !confirm(
    "Delete qualification?"
    )
    )
    return;

    const response = await fetch(
        `/api/teacher/profile/qualifications/${id}`,
        {
            method: "DELETE",
        }
    );

    if (!response.ok) {
        const error = await response.json();
        alert(error.message);
        return;
    }

    await RefreshQualifications();

  }

  if (loading) {
  return (
    <div className="animate-pulse overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
        <div className="space-y-1.5">
          <div className="h-4 w-32 rounded bg-slate-200" />
          <div className="h-3 w-52 rounded bg-slate-200" />
        </div>
        <div className="h-7 w-32 rounded-lg bg-slate-200" />
      </div>

      <div className="space-y-4 p-5">
        <div className="flex gap-4">
          <div className="h-8 w-8 shrink-0 rounded-full bg-slate-200" />
          <div className="h-20 flex-1 rounded-xl bg-slate-100" />
        </div>
        <div className="flex gap-4">
          <div className="h-8 w-8 shrink-0 rounded-full bg-slate-200" />
          <div className="h-20 flex-1 rounded-xl bg-slate-100" />
        </div>
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
            Qualifications
          </h3>

          <p className="mt-0.5 text-[14px] text-slate-500">
            Academic and professional educational background.
          </p>
        </div>

        {!isPublic && (<button
          onClick={openAddDrawer}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[14px] font-medium text-white transition hover:bg-emerald-700"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Qualification
        </button>)}
      </div>

      {/* Timeline */}
      <div className="p-5">
        {qualifications.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 p-5 text-center text-[14px] text-slate-500">
            No qualifications added yet.
          </div>
        ) : (
        <div className="relative">
          {/* Vertical line */}
          <div className="absolute left-[15px] top-0 h-full w-0.5 bg-slate-200" />

          <div className="space-y-4">
            {qualifications.map((qualification) => (
              <div
                key={qualification.id}
                className="relative flex gap-4"
              >
                {/* Timeline Dot */}
                <div className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100">
                  <GraduationCap className="h-4 w-4 text-emerald-600" />
                </div>

                {/* Content */}
                <div className="flex-1 rounded-xl border border-slate-100 bg-slate-50 p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="text-[16px] font-semibold text-slate-900">
                        {qualification.title}
                      </h4>

                      <p className="mt-0.5 text-[14px] font-medium text-orange-600">
                        {qualification.institute}
                      </p>

                      <div className="mt-2 inline-flex rounded-full bg-orange-100 px-2 py-0.5 text-[12px] font-semibold text-orange-700">
                        {qualification.startYear} - {qualification.endYear}
                      </div>
                    </div>

                    {isPublic?null:(<div className="flex shrink-0 items-center gap-0.5">
                      <button
                        onClick={() => openEditDrawer(qualification)}
                        className="rounded-md p-1 text-slate-400 transition hover:bg-white hover:text-slate-600"
                        title="Edit Qualification"
                    >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>

                      <button
                          onClick={() =>
                              deleteQualification(qualification.id)
                          }
                          className="rounded-md p-1 text-red-400 transition hover:bg-red-50 hover:text-red-600"
                          title="Delete Qualification"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        )}

        {/* Footer */}
        <div className="mt-4 rounded-xl border border-orange-100 bg-gradient-to-r from-orange-50 to-emerald-50 p-3">
          <p className="text-[14px] leading-5 text-slate-700">
            Displaying professional qualifications helps students and parents understand your academic background and teaching credibility.
          </p>
        </div>
      </div>

      <QualificationDrawer
          open={drawerOpen}
          qualification={editingQualification}
          saving={saving}
          onClose={() => {
              setDrawerOpen(false);
              setEditingQualification(null);
          }}
          onSave={saveQualification}
      />

    </div>
  );
}