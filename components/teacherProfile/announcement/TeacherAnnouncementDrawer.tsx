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

      <div className="fixed right-0 top-0 z-50 flex h-screen w-full max-w-lg flex-col bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-100">
              <Megaphone className="h-4 w-4 text-orange-600" />
            </div>

            <div>
              <h2 className="text-[15px] font-bold text-slate-900">
                {isEditing ? "Edit Announcement" : "Add Announcement"}
              </h2>
              <p className="text-[12.5px] text-slate-500">
                Share updates with students visiting your profile.
              </p>
            </div>
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
            {/* Image */}
            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Announcement Image
              </label>

              <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                {previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={previewUrl}
                    alt="Announcement preview"
                    className="max-h-48 w-full object-contain"
                  />
                ) : (
                  <div className="flex h-32 items-center justify-center text-[13px] text-slate-400">
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
                className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px] font-medium text-slate-700 transition hover:bg-slate-50"
              >
                <ImagePlus className="h-3.5 w-3.5" />
                {previewUrl ? "Change image" : "Choose image"}
              </button>

              <p className="mt-1 text-[12px] text-slate-400">
                JPG, PNG, WEBP or GIF. Up to 5 MB.
              </p>
            </div>

            {/* Description */}
            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Description
              </label>

              <textarea
                rows={5}
                value={description}
                maxLength={1000}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Write your announcement, e.g. new batch starting next week, exam schedule changes, holiday notices..."
                className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none transition focus:border-orange-500"
              />

              <p className="mt-1 text-right text-[12px] text-slate-400">
                {description.length}/1000
              </p>
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
            onClick={submit}
            className="flex items-center gap-1.5 rounded-md bg-[#4D6C90] px-3.5 py-1.5 text-[13px] font-semibold text-white transition hover:bg-[#3B5776] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save className="h-3.5 w-3.5" />
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
