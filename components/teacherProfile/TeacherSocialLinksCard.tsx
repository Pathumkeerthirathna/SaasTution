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
}

export default function TeacherSocialLinksCard({
  onEdit,
}: Props) {
  
  const [socialLinks, setSocialLinks] =
  useState<SocialLinks>({
      facebookUrl:"",
      youtubeUrl:"",
      tiktokUrl:"",
      instagramUrl:"",
      websiteUrl:"",
  });

  const [loading,setLoading]=
  useState(true);

  const [saving,setSaving]=
  useState(false);

  const [drawerOpen,setDrawerOpen]=
  useState(false);

  useEffect(()=>{
      loadSocialLinks();
  },[]);

  async function loadSocialLinks(){

      try{

          setLoading(true);

          const response=
          await fetch(
              "/api/teacher/profile/social-links"
          );

          const data=
          await response.json();

          setSocialLinks(data);

      }
      finally{

          setLoading(false);

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

          await loadSocialLinks();

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
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
        <div>
          <h3 className="text-lg font-bold text-slate-900">
            Social & Online Presence
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            Connect students with your online
            channels and content.
          </p>
        </div>

        <button
          onClick={() => setDrawerOpen(true)}
          className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-100"
        >
          <Edit className="h-4 w-4" />
          Edit
        </button>
      </div>

      {/* Body */}
      <div className="p-6">
        <div className="space-y-3">
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
                className={`flex items-center gap-4 rounded-xl border border-slate-100 p-4 transition
                  ${
                    social.value
                      ? "cursor-pointer hover:bg-slate-50"
                      : "cursor-not-allowed opacity-60"
                  }`}
              >
                <div
                  className={`flex h-11 w-11 items-center justify-center rounded-xl ${social.bg}`}
                >
                  <Icon className={`h-5 w-5 ${social.text}`} />
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-900">
                    {social.name}
                  </p>

                  <p className="truncate text-sm text-slate-500">
                    {social.value || "Not Added"}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer Message */}
        <div className="mt-6 rounded-xl border border-emerald-100 bg-gradient-to-r from-emerald-50 to-orange-50 p-4">
          <p className="text-sm leading-6 text-slate-700">
            Add your social links and website to
            strengthen your personal teaching
            brand and help students discover your
            educational content.
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