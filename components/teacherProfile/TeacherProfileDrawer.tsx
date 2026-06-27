"use client";

import { X } from "lucide-react";

interface Props {
  open: boolean;
  mode: string;
  onClose: () => void;
}

export default function TeacherProfileDrawer({
  open,
  mode,
  onClose,
}: Props) {
  if (!open) return null;

  const getTitle = () => {
    switch (mode) {
      case "profile":
        return "Edit Profile";

      case "about":
        return "Edit About Me";

      case "mediums":
        return "Manage Teaching Mediums";

      case "social":
        return "Manage Social Links";

      case "qualification":
        return "Manage Qualifications";

      case "achievement":
        return "Manage Achievements";

      case "subjects":
        return "Manage Subjects";

      default:
        return "Edit";
    }
  };

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 z-50 h-screen w-full max-w-[700px] overflow-hidden bg-white shadow-2xl">
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-slate-200 px-6 py-5">
            <div>
              <h2 className="text-xl font-bold text-slate-900">
                {getTitle()}
              </h2>

              <p className="mt-1 text-sm text-slate-500">
                Update your profile information.
              </p>
            </div>

            <button
              onClick={onClose}
              className="rounded-xl border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Content */}
          {/* <div className="flex-1 overflow-y-auto p-6">
            {mode === "profile" && (
              <ProfileForm />
            )}

            {mode === "about" && (
              <AboutForm />
            )}

            {mode === "mediums" && (
              <MediumsForm />
            )}

            {mode === "social" && (
              <SocialLinksForm />
            )}

            {mode === "qualification" && (
              <QualificationForm />
            )}

            {mode === "achievement" && (
              <AchievementForm />
            )}

            {mode === "subjects" && (
              <SubjectsForm />
            )}
          </div> */}
        </div>
      </div>
    </>
  );
}