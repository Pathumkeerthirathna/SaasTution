"use client";

import { Save, User, X } from "lucide-react";
import { useEffect, useState } from "react";

interface Props {
  open: boolean;
  saving: boolean;
  initialValue: string;
  onSave: (aboutMe: string) => void;
  onClose: () => void;
}

export default function AboutMeDrawer({
  open,
  saving,
  initialValue,
  onSave,
  onClose,
}: Props) {
  const [aboutMe, setAboutMe] = useState("");

  useEffect(() => {
    if (open) {
      setAboutMe(initialValue ?? "");
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
      <div className="fixed right-0 top-0 z-50 flex h-screen w-full max-w-2xl flex-col bg-white shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-5">

          <div className="flex items-center gap-3">

            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-100">
              <User className="h-6 w-6 text-emerald-600" />
            </div>

            <div>

              <h2 className="text-[22px] font-bold text-slate-900">
                About Me
              </h2>

              <p className="text-[16px] text-slate-500">
                Introduce yourself to students and parents.
              </p>

            </div>

          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 transition hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>

        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">

          <div>

            <label className="mb-2 block text-[16px] font-semibold text-slate-700">
              About Me
            </label>

            <textarea
              rows={12}
              maxLength={1000}
              value={aboutMe}
              onChange={(e) =>
                setAboutMe(e.target.value)
              }
              placeholder="Introduce yourself, describe your teaching experience, teaching style, achievements and how you help students succeed..."
              className="
                w-full
                resize-none
                rounded-2xl
                border
                border-slate-300
                p-4
                text-[16px]
                leading-7
                outline-none
                transition
                focus:border-emerald-500
                focus:ring-2
                focus:ring-emerald-100
              "
            />

            <div className="mt-2 flex items-center justify-between">

              <p className="text-[14px] text-slate-500">
                This section appears on your public teacher profile.
              </p>

              <span className="text-[14px] font-medium text-slate-500">
                {aboutMe.length}/1000
              </span>

            </div>

          </div>

          {/* Tips */}
          <div className="mt-6 rounded-2xl border border-orange-100 bg-gradient-to-r from-orange-50 to-emerald-50 p-5">

            <h4 className="font-semibold text-slate-800">
              Tips for a great profile
            </h4>

            <ul className="mt-3 space-y-2 text-[16px] leading-6 text-slate-600">
              <li>• Mention your teaching experience.</li>
              <li>• Explain your teaching methodology.</li>
              <li>• Highlight qualifications or achievements.</li>
              <li>• Tell students how you help them improve.</li>
            </ul>

          </div>

        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 border-t border-slate-200 bg-slate-50 px-6 py-5">

          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-300 px-5 py-2.5 font-medium text-slate-700 transition hover:bg-white"
          >
            Cancel
          </button>

          <button
            type="button"
            disabled={saving}
            onClick={() => onSave(aboutMe)}
            className="flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-2.5 font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save className="h-4 w-4" />

            {saving ? "Saving..." : "Save About Me"}
          </button>

        </div>

      </div>
    </>
  );
}