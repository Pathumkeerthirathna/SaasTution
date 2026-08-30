"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Megaphone, Save, X } from "lucide-react";

import { AnnouncementForm } from "@/types/teacherProfileTypes/announcement/announcement-types";

interface Props {
  open: boolean;
  saving: boolean;
  /** Present when editing an existing announcement. */
  initialValue?: {
    description: string;
    imageUrl: string;
  };
  onSave: (form: AnnouncementForm) => void;
  onClose: () => void;
}

export default function TeacherAnnouncementDrawer({
  open,
  saving,
  initialValue,
  onSave,
  onClose,
}: Props) {
  const isEditing = initialValue != null;

  const [description, setDescription] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;

    setDescription(initialValue?.description ?? "");
    setImageFile(null);
    setPreviewUrl(initialValue?.imageUrl ?? null);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [open, initialValue]);

  useEffect(() => {
    if (!imageFile) return;

    const objectUrl = URL.createObjectURL(imageFile);
    setPreviewUrl(objectUrl);

    return () => URL.revokeObjectURL(objectUrl);
  }, [imageFile]);

  if (!open) return null;

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setImageFile(file);
  }

  function submit() {
    if (!description.trim()) {
      alert("Description is required.");
      return;
    }

    if (!isEditing && !imageFile) {
      alert("Please choose an image for the announcement.");
      return;
    }

    onSave({ description: description.trim(), imageFile });
  }

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
      />

      <div className="fixed right-0 top-0 z-50 flex h-screen w-full max-w-xl flex-col bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-100">
              <Megaphone className="h-6 w-6 text-orange-600" />
            </div>

            <div>
              <h2 className="text-[22px] font-bold text-slate-900">
                {isEditing ? "Edit Announcement" : "Add Announcement"}
              </h2>
              <p className="text-[15px] text-slate-500">
                Share updates with students visiting your profile.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="rounded-lg p-2 transition hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="space-y-6">
            {/* Image */}
            <div>
              <label className="mb-2 block text-[15px] font-semibold text-slate-700">
                Announcement Image
              </label>

              <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                {previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={previewUrl}
                    alt="Announcement preview"
                    className="max-h-64 w-full object-contain"
                  />
                ) : (
                  <div className="flex h-40 items-center justify-center text-[14px] text-slate-400">
                    No image selected
                  </div>
                )}
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={handleFileChange}
                className="hidden"
              />

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-[14px] font-medium text-slate-700 transition hover:bg-slate-50"
              >
                <ImagePlus className="h-4 w-4" />
                {previewUrl ? "Change image" : "Choose image"}
              </button>

              <p className="mt-1.5 text-[13px] text-slate-400">
                JPG, PNG, WEBP or GIF. Up to 5 MB.
              </p>
            </div>

            {/* Description */}
            <div>
              <label className="mb-2 block text-[15px] font-semibold text-slate-700">
                Description
              </label>

              <textarea
                rows={6}
                value={description}
                maxLength={1000}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Write your announcement, e.g. new batch starting next week, exam schedule changes, holiday notices..."
                className="w-full resize-none rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-orange-500"
              />

              <p className="mt-1 text-right text-[12px] text-slate-400">
                {description.length}/1000
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 border-t border-slate-200 bg-slate-50 px-6 py-5">
          <button
            onClick={onClose}
            className="rounded-xl border border-slate-300 px-5 py-2.5 font-medium text-slate-700 transition hover:bg-white"
          >
            Cancel
          </button>

          <button
            disabled={saving}
            onClick={submit}
            className="flex items-center gap-2 rounded-xl bg-orange-500 px-6 py-2.5 font-semibold text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save className="h-4 w-4" />
            {saving
              ? "Saving..."
              : isEditing
              ? "Update Announcement"
              : "Publish Announcement"}
          </button>
        </div>
      </div>
    </>
  );
}
