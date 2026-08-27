"use client";


import { Edit, Languages } from "lucide-react";
import { useEffect, useState } from "react";
import { Medium, TeacherMedium } from "./Medium/medium-types";
import TeacherMediumDrawer from "./Medium/TeacherMediumDrawer";

interface Props {
  teacherId:string;
  isPublic?: boolean;
}

export default function TeacherMediumsCard({
  teacherId,
  isPublic
}:Props) {
  

const [drawerOpen, setDrawerOpen] =
  useState(false);

const [teacherMediums, setTeacherMediums] =
  useState<Medium[]>([]);

const [allMediums, setAllMediums] =
  useState<Medium[]>([]);

const [selectedMediumIds, setSelectedMediumIds] =
  useState<number[]>([]);

const [saving, setSaving] =
  useState(false);

const [loading, setLoading] =
  useState(true);

  useEffect(() => {

    async function loadMediums() {
      try {
        setLoading(true);

        const response = await fetch(
          `/api/teacher/profile/mediums?teacherId=${teacherId}`
        );

        if (!response.ok)
          throw new Error("Failed to load mediums.");

        const data: TeacherMedium[] =
          await response.json();

        setTeacherMediums(
          data.map((x) => x.medium)
        );

      } finally {
        setLoading(false);
      }
    }

    loadMediums();

  }, []);


  async function RefreshMediums() {
    try {
      setLoading(true);

      const response = await fetch(
        `/api/teacher/profile/mediums?teacherId=${teacherId}`
      );

      if (!response.ok)
        throw new Error("Failed to load mediums.");

      const data: TeacherMedium[] =
        await response.json();

      setTeacherMediums(
        data.map((x) => x.medium)
      );

    } finally {
      setLoading(false);
    }
  }

  

  // async function openDrawer() {

  // const [allResponse, selectedResponse] =
  //     await Promise.all([

  //       fetch(
  //         "/api/teacher/profile/mediums/all"
  //       ),

  //       fetch(
  //         "/api/teacher/profile/mediums"
  //       ),

  //     ]);

  //   const allMediums: Medium[] =
  //     await allResponse.json();

  //   const selected: TeacherMedium[] =
  //     await selectedResponse.json();

  //   setAllMediums(allMediums);

  //   setSelectedMediumIds(
  //     selected.map(x => x.medium.id)
  //   );

  //   setDrawerOpen(true);

  // }

  async function openDrawer() {
    try {
      console.log("Opening drawer...");

      const [allResponse, selectedResponse] = await Promise.all([
        fetch("/api/teacher/profile/mediums/all"),
        fetch(`/api/teacher/profile/mediums?teacherId=${teacherId}`),
      ]);

      console.log(allResponse.status);
      console.log(selectedResponse.status);

      if (!allResponse.ok) {
        throw new Error("Failed to load all mediums");
      }

      if (!selectedResponse.ok) {
        throw new Error("Failed to load selected mediums");
      }

      const allMediums: Medium[] = await allResponse.json();
      const selected: TeacherMedium[] = await selectedResponse.json();

      console.log(allMediums);
      console.log(selected);

      setAllMediums(allMediums);

      setSelectedMediumIds(
        selected.map((x) => x.medium.id)
      );

      setDrawerOpen(true);
    } catch (err) {
      console.error(err);
    }
  }

  function toggleMedium(id: number) {
    setSelectedMediumIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((x) => x !== id);
      }

      return [...prev, id];
    });
  }

  async function saveMediums() {
    try {
      setSaving(true);

      const response = await fetch(
        "/api/teacher/profile/mediums",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            mediumIds: selectedMediumIds,
          }),
        }
      );

      if (!response.ok) {
        throw new Error("Failed to save mediums.");
      }

      setDrawerOpen(false);

      await RefreshMediums();

    } finally {
      setSaving(false);
    }
  }

  if (loading) {
  return (
    <div className="animate-pulse overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
        <div className="space-y-1.5">
          <div className="h-4 w-32 rounded bg-slate-200" />
          <div className="h-3 w-40 rounded bg-slate-200" />
        </div>
        <div className="h-7 w-7 rounded-lg bg-slate-200" />
      </div>

      <div className="space-y-3 p-5">
        <div className="h-10 w-40 rounded-lg bg-slate-100" />
        <div className="flex gap-2">
          <div className="h-7 w-20 rounded-full bg-slate-100" />
          <div className="h-7 w-24 rounded-full bg-slate-100" />
          <div className="h-7 w-16 rounded-full bg-slate-100" />
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
            Teaching Mediums
          </h3>

          <p className="mt-0.5 text-[14px] text-slate-500">
            Languages available for teaching.
          </p>
        </div>

        {isPublic ? null : (
          <button
            onClick={openDrawer}
            title="Edit teaching mediums"
            aria-label="Edit teaching mediums"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 transition hover:bg-emerald-100"
          >
            <Edit className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Body */}
      <div className="p-5">
        <div className="mb-4 flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100">
            <Languages className="h-4 w-4 text-emerald-600" />
          </div>

          <div>
            <p className="text-[13px] text-slate-500">
              Available Mediums
            </p>

            <p className="text-[16px] font-semibold leading-tight text-slate-900">
              {teacherMediums.length} Mediums
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {teacherMediums.map((medium) => (
            <div
              key={medium.id}
              className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[14px] font-semibold text-emerald-700"
            >
              {medium.name}
            </div>
          ))}
        </div>

        {/* Info Box */}
        <div className="mt-4 rounded-xl border border-orange-100 bg-orange-50 p-3">
          <p className="text-[14px] leading-5 text-orange-700">
            Students can easily identify the languages you teach in when viewing your public profile.
          </p>
        </div>
      </div>
      <TeacherMediumDrawer
        open={drawerOpen}
        saving={saving}
        mediums={allMediums}
        selectedMediumIds={selectedMediumIds}
        onToggle={toggleMedium}
        onSave={saveMediums}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
}