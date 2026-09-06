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
    <div className="animate-pulse overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
        <div className="space-y-1.5">
          <div className="h-4 w-24 rounded bg-slate-200" />
          <div className="h-3 w-44 rounded bg-slate-200" />
        </div>
        <div className="h-7 w-14 rounded-lg bg-slate-200" />
      </div>

      <div className="space-y-2 p-5">
        <div className="h-3 w-full rounded bg-slate-200" />
        <div className="h-3 w-11/12 rounded bg-slate-200" />
        <div className="h-3 w-10/12 rounded bg-slate-200" />
        <div className="mt-4 h-16 w-full rounded-xl bg-slate-100" />
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
            About Me
          </h3>

          <p className="mt-0.5 text-[14px] text-slate-500">
            Professional introduction and teaching background.
          </p>
        </div>

        {!isPublic && (<button
          onClick={() => setDrawerOpen(true)}
          className="inline-flex items-center gap-1 rounded-md border border-[#4D6C90]/30 bg-[#4D6C90]/5 px-2 py-1 text-[12.5px] font-medium text-[#4D6C90] transition hover:bg-[#4D6C90]/10"
        >
          <Edit className="h-3 w-3" />
          Edit
        </button>)}


      </div>

      {/* Body */}
      <div className="p-5">
        {loading ? (
            <p className="text-[14px] text-slate-400">
                Loading...
            </p>
        ) : aboutMe ? (
            <p className="text-[15px] leading-6 text-slate-600">
                {aboutMe}
            </p>
        ) : isPublic ? null : (
            <div className="rounded-lg border border-dashed border-slate-300 p-5 text-center">

                <p className="text-[14px] text-slate-500">
                    Tell students about yourself, your teaching style and your experience.
                </p>

                <button
                    onClick={() => setDrawerOpen(true)}
                    className="mt-3 rounded-md bg-[#4D6C90] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[#3B5776]"
                >
                    Add About Me
                </button>

            </div>
        )}

        {/* Quote */}
        <div className="mt-4 rounded-xl border border-orange-100 bg-gradient-to-r from-orange-50 to-emerald-50 p-4">
          <p className="text-[14px] italic leading-6 text-slate-700">
              &#34;Education is not about memorizing facts. It is about understanding concepts and developing the confidence to solve problems independently.&#34;
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