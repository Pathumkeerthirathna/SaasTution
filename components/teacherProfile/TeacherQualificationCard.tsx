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

// interface Props {
//   onAdd?: () => void;
// }

export default function TeacherQualificationCard({
  
}) {


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
    loadQualifications();
  }, []);

  async function loadQualifications() {
    try {
      const res = await fetch(
        "/api/teacher/profile/qualifications"
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

          await loadQualifications();

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

    await loadQualifications();

  }

  

  return (

    

    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
        <div>
          <h3 className="text-lg font-bold text-slate-900">
            Qualifications
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            Academic and professional educational
            background.
          </p>
        </div>

        <button
          onClick={openAddDrawer}
          className="flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700"
        >
          <Plus className="h-4 w-4" />
          Add Qualification
        </button>
      </div>

      {/* Timeline */}
      <div className="p-6">
        <div className="relative">
          {/* Vertical line */}
          <div className="absolute left-[19px] top-0 h-full w-0.5 bg-slate-200" />

          <div className="space-y-6">
            {qualifications.map((qualification) => (
              <div
                key={qualification.id}
                className="relative flex gap-5"
              >
                {/* Timeline Dot */}
                <div className="relative z-10 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
                  <GraduationCap className="h-5 w-5 text-emerald-600" />
                </div>

                {/* Content */}
                <div className="flex-1 rounded-2xl border border-slate-100 bg-slate-50 p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <h4 className="text-lg font-semibold text-slate-900">
                        {qualification.title}
                      </h4>

                      <p className="mt-1 text-sm font-medium text-orange-600">
                        {qualification.institute}
                      </p>

                      <div className="mt-3 inline-flex rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-700">
                        {qualification.startYear} -{" "}
                        {qualification.endYear}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => openEditDrawer(qualification)}
                        className="rounded-xl border border-slate-200 p-2 text-slate-600 transition hover:bg-white"
                        title="Edit Qualification"
                    >
                        <Pencil className="h-4 w-4" />
                      </button>

                      <button
                          onClick={() =>
                              deleteQualification(qualification.id)
                          }
                          className="rounded-xl border border-red-200 p-2 text-red-500 transition hover:bg-red-50"
                          title="Delete Qualification"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 rounded-xl border border-orange-100 bg-gradient-to-r from-orange-50 to-emerald-50 p-4">
          <p className="text-sm leading-6 text-slate-700">
            Displaying professional qualifications
            helps students and parents understand
            your academic background and teaching
            credibility.
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