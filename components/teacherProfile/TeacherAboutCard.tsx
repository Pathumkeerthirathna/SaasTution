"use client";

import {
  Edit,
} from "lucide-react";
import { useEffect, useState } from "react";
import AboutMeDrawer from "./About/AboutMeDrawer";

interface Props {
  onEdit?: () => void;
  teacherId:string;
  isPublic?: boolean;
}

export default function TeacherAboutCard({
  teacherId,
  isPublic
  
}: Props) {

  console.log("teacherId", teacherId);
  
  const [aboutMe, setAboutMe] =
    useState("");

  const [loading, setLoading] =
      useState(true);

  const [saving, setSaving] =
      useState(false);

  const [drawerOpen, setDrawerOpen] =
      useState(false);

  useEffect(() => {

      async function loadAbout() {

          try{

              setLoading(true);
              

              const response =
                  await fetch(
                    `/api/public/teacher/about?teacherId=${teacherId}`
                  );

                  
          const responseData = await response.json();

          console.log(responseData);

          setAboutMe(responseData.data.aboutMe ?? "");

          }
          finally{

              setLoading(false);

          }

      }

      loadAbout();
  }, []);

  

  async function refreshAbout() {
      try {
          setLoading(true);

          const response = await fetch(
              `/api/public/teacher/about?teacherId=${teacherId}`
          );

          const responseData = await response.json();

          setAboutMe(responseData.data.aboutMe ?? "");
      } finally {
          setLoading(false);
      }
  }

  async function saveAbout(
    text:string
  ){

      try{

          setSaving(true);

          await fetch(
              "/api/teacher/profile/about",
              {
                  method:"PUT",

                  headers:{
                      "Content-Type":
                      "application/json"
                  },

                  body:JSON.stringify({
                      aboutMe:text
                  })
              }
          );

          setDrawerOpen(false);

          await refreshAbout();

      }
      finally{

          setSaving(false);

      }

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
      <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
        <div>
          <h3 className="text-lg font-bold text-slate-900">
            About Me
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            Professional introduction and teaching
            background.
          </p>
        </div>

        {!isPublic && (<button
          onClick={() => setDrawerOpen(true)}
          className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-100"
        >
          <Edit className="h-4 w-4" />
          Edit
        </button>)}

        
      </div>

      {/* Body */}
      <div className="p-6">
        {loading ? (
            <p className="text-slate-400">
                Loading...
            </p>
        ) : aboutMe ? (
            <p className="leading-8 text-slate-600">
                {aboutMe}
            </p>
        ) : (
            <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center">

                <p className="text-slate-500">
                    Tell students about yourself, your teaching style and your experience.
                </p>

                <button
                    onClick={() => setDrawerOpen(true)}
                    className="mt-4 rounded-xl bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700"
                >
                    Add About Me
                </button>

            </div>
        )}

        {/* Quote */}
        <div className="mt-6 rounded-2xl border border-orange-100 bg-gradient-to-r from-orange-50 to-emerald-50 p-5">
          <p className="text-sm italic leading-7 text-slate-700">
              &#34;Education is not about memorizing facts.
              It is about understanding concepts and
              developing the confidence to solve
              problems independently.&#34;
          </p>
        </div>
      </div>

      <AboutMeDrawer
          open={drawerOpen}
          saving={saving}
          initialValue={aboutMe}
          onSave={saveAbout}
          onClose={() => setDrawerOpen(false)}
      />
      
    </div>
  );
}