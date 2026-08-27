"use client";

import { SocialLinks } from "@/types/teacherProfileTypes/SocialLink/types";
import {
  Edit,
  ScanFace,
  Globe,
  ImageMinus,
  AArrowDown,
} from "lucide-react";
import { useEffect, useState } from "react";
import SocialLinksDrawer from "./SocialLinks/SocialLinksDrawer";

interface Props {
  onEdit?: () => void;
  teacherId:string;
  isPublic?: boolean;
}

export default function TeacherSocialLinksCard({
  teacherId,
  isPublic
}: Props) {
  
  const [socialLinks, setSocialLinks] =
  useState<SocialLinks>({
      facebookUrl:"",
      youtubeUrl:"",
      tiktokUrl:"",
      instagramUrl:"",
      websiteUrl:"",
  });

  // const [loading,setLoading]=
  // useState(true);

  const [saving,setSaving]=
  useState(false);

  const [drawerOpen,setDrawerOpen]=
  useState(false);

  useEffect(()=>{

    async function loadSocialLinks(){

        try{

            // setLoading(true);

            const response=
            await fetch(
                `/api/teacher/profile/social-links?teacherId=${teacherId}`
            );

            const data=
            await response.json();

            setSocialLinks(data);

        }
        finally{

            // setLoading(false);

        }

    }

      loadSocialLinks();

  },[]);

  async function RefreshSocialLinks(){

      try{

          // setLoading(true);

          const response=
          await fetch(
              `/api/teacher/profile/social-links?teacherId=${teacherId}`
          );

          const data=
          await response.json();

          setSocialLinks(data);

      }
      finally{

          // setLoading(false);

      }

  }

  

  async function saveSocialLinks(
  form:SocialLinks
  ){

      try{

          setSaving(true);

          await fetch(
              "/api/teacher/profile/social-links",
              {
                  method:"PUT",

                  headers:{
                      "Content-Type":"application/json"
                  },

                  body:JSON.stringify(form)
              }
          );

          setDrawerOpen(false);

          await RefreshSocialLinks();

      }
      finally{

          setSaving(false);

      }

  }

  const items = [
    {
      name: "Facebook",
      value: socialLinks.facebookUrl,
      icon: ScanFace,
      bg: "bg-blue-100",
      text: "text-blue-600",
    },
    {
      name: "YouTube",
      value: socialLinks.youtubeUrl,
      icon: ImageMinus,
      bg: "bg-red-100",
      text: "text-red-600",
    },
    {
      name: "Instagram",
      value: socialLinks.instagramUrl,
      icon: AArrowDown,
      bg: "bg-pink-100",
      text: "text-pink-600",
    },
    {
      name: "TikTok",
      value: socialLinks.tiktokUrl,
      icon: ImageMinus,
      bg: "bg-slate-200",
      text: "text-slate-700",
    },
    {
      name: "Website",
      value: socialLinks.websiteUrl,
      icon: Globe,
      bg: "bg-emerald-100",
      text: "text-emerald-600",
    },
  ];

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
        <div>
          <h3 className="text-[16px] font-bold text-slate-900">
            Social &amp; Online Presence
          </h3>

          <p className="mt-0.5 text-[14px] text-slate-500">
            Connect students with your online channels and content.
          </p>
        </div>

        {isPublic ? null : (<button
          onClick={() => setDrawerOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[14px] font-medium text-emerald-700 transition hover:bg-emerald-100"
        >
          <Edit className="h-3.5 w-3.5" />
          Edit
        </button>)}
      </div>

      {/* Body */}
      <div className="p-5">
        <div className="space-y-2">
          {items.map((social) => {
            const Icon = social.icon;

            return (
              <div
                key={social.name}
                onClick={() => {
                  if (social.value) {
                    window.open(social.value, "_blank", "noopener,noreferrer");
                  }
                }}
                className={`flex items-center gap-2.5 rounded-lg border border-slate-100 p-2.5 transition
                  ${
                    social.value
                      ? "cursor-pointer hover:bg-slate-50"
                      : "cursor-not-allowed opacity-60"
                  }`}
              >
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${social.bg}`}
                >
                  <Icon className={`h-4 w-4 ${social.text}`} />
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold text-slate-900">
                    {social.name}
                  </p>

                  <p className="truncate text-[13px] text-slate-500">
                    {social.value || "Not Added"}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer Message */}
        <div className="mt-4 rounded-xl border border-emerald-100 bg-gradient-to-r from-emerald-50 to-orange-50 p-3">
          <p className="text-[14px] leading-5 text-slate-700">
            Add your social links and website to strengthen your teaching brand and help students discover your content.
          </p>
        </div>
      </div>

      <SocialLinksDrawer
          open={drawerOpen}
          saving={saving}
          initialValue={socialLinks}
          onSave={saveSocialLinks}
          onClose={() => setDrawerOpen(false)}
      />

    </div>
  );
}