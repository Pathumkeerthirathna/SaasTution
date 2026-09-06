"use client";

import { useEffect, useState } from "react";

import { Globe, Save, X } from "lucide-react";

import {
  FaFacebook,
  FaInstagram,
  FaYoutube,
  FaTiktok,
} from "react-icons/fa";
import { SocialLinks } from "@/types/teacherProfileTypes/SocialLink/types";

interface Props {
  open: boolean;
  saving: boolean;
  initialValue: SocialLinks;
  onSave: (data: SocialLinks) => void;
  onClose: () => void;
}

const emptyForm: SocialLinks = {
  facebookUrl: "",
  youtubeUrl: "",
  instagramUrl: "",
  tiktokUrl: "",
  websiteUrl: "",
};

export default function SocialLinksDrawer({
  open,
  saving,
  initialValue,
  onSave,
  onClose,
}: Props) {
  const [form, setForm] = useState<SocialLinks>(emptyForm);

  useEffect(() => {
    if (open) {
      setForm(initialValue ?? emptyForm);
    }
  }, [open, initialValue]);

  if (!open) return null;

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 z-50 flex h-screen w-full max-w-lg flex-col bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-bold text-slate-900">
              Social & Online Presence
            </h2>

            <p className="mt-0.5 text-[12.5px] text-slate-500">
              Connect students with your online platforms.
            </p>
          </div>

          <button
            onClick={onClose}
            className="rounded-md p-1.5 transition hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          <div className="space-y-4">
            {/* Facebook */}
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-slate-700">
                <FaFacebook className="h-3.5 w-3.5 text-blue-600" />
                Facebook
              </label>

              <input
                value={form.facebookUrl}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    facebookUrl: e.target.value,
                  }))
                }
                placeholder="https://facebook.com/yourpage"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none transition focus:border-emerald-500"
              />
            </div>

            {/* YouTube */}
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-slate-700">
                <FaYoutube className="h-3.5 w-3.5 text-red-600" />
                YouTube
              </label>

              <input
                value={form.youtubeUrl}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    youtubeUrl: e.target.value,
                  }))
                }
                placeholder="https://youtube.com/@yourchannel"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none transition focus:border-emerald-500"
              />
            </div>

            {/* Instagram */}
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-slate-700">
                <FaInstagram className="h-3.5 w-3.5 text-pink-600" />
                Instagram
              </label>

              <input
                value={form.instagramUrl}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    instagramUrl: e.target.value,
                  }))
                }
                placeholder="https://instagram.com/yourprofile"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none transition focus:border-emerald-500"
              />
            </div>

            {/* TikTok */}
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-slate-700">
                <FaTiktok className="h-3.5 w-3.5" />
                TikTok
              </label>

              <input
                value={form.tiktokUrl}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    tiktokUrl: e.target.value,
                  }))
                }
                placeholder="https://tiktok.com/@yourprofile"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none transition focus:border-emerald-500"
              />
            </div>

            {/* Website */}
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-slate-700">
                <Globe className="h-3.5 w-3.5 text-emerald-600" />
                Website
              </label>

              <input
                value={form.websiteUrl}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    websiteUrl: e.target.value,
                  }))
                }
                placeholder="https://www.yourwebsite.com"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none transition focus:border-emerald-500"
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3.5">
          <button
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3.5 py-1.5 text-[13px] font-medium text-slate-700 transition hover:bg-white"
          >
            Cancel
          </button>

          <button
            disabled={saving}
            onClick={() => onSave(form)}
            className="flex items-center gap-1.5 rounded-md bg-[#4D6C90] px-3.5 py-1.5 text-[13px] font-semibold text-white transition hover:bg-[#3B5776] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </>
  );
}
