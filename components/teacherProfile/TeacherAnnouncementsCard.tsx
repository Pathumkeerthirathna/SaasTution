"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ImageOff,
  Megaphone,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import {
  AnnouncementForm,
  MAX_TEACHER_ANNOUNCEMENTS,
  TeacherAnnouncement,
} from "@/types/teacherProfileTypes/announcement/announcement-types";
import TeacherAnnouncementDrawer from "./announcement/TeacherAnnouncementDrawer";

interface Props {
  teacherId: string;
  isPublic?: boolean;
}

interface ApiResponse {
  success?: boolean;
  data?: TeacherAnnouncement[];
  error?: { message?: string };
  message?: string;
}

function readError(payload: ApiResponse, fallback: string) {
  return payload.error?.message ?? payload.message ?? fallback;
}

function SlideImage({ src }: { src: string }) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    setStatus("loading");
  }, [src]);

  return (
    <div className="relative aspect-[4/3] w-full bg-slate-100">
      {status !== "error" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt="Announcement"
          onLoad={() => setStatus("ready")}
          onError={() => setStatus("error")}
          className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${
            status === "ready" ? "opacity-100" : "opacity-0"
          }`}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-slate-400">
          <ImageOff className="h-6 w-6" />
          <span className="text-[12px]">Image unavailable</span>
        </div>
      )}

      {status === "loading" && (
        <div className="absolute inset-0 animate-pulse bg-slate-200/60" />
      )}
    </div>
  );
}

export default function TeacherAnnouncementsCard({ teacherId, isPublic }: Props) {
  const [announcements, setAnnouncements] = useState<TeacherAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<TeacherAnnouncement | null>(null);

  // Carousel state — manual navigation only, starts on the first announcement.
  const [activeIndex, setActiveIndex] = useState(0);

  async function loadAnnouncements() {
    try {
      setLoading(true);

      const response = await fetch(
        `/api/public/teacher/announcements?teacherId=${teacherId}`,
        { cache: "no-store" }
      );
      const payload = (await response.json()) as ApiResponse;

      setAnnouncements(payload.data ?? []);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!teacherId) return;
    void loadAnnouncements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacherId]);

  // Keep the active slide in range whenever the list size changes.
  useEffect(() => {
    setActiveIndex((index) =>
      announcements.length === 0
        ? 0
        : Math.min(index, announcements.length - 1)
    );
  }, [announcements.length]);

  function goTo(index: number) {
    const count = announcements.length;
    if (count === 0) return;
    setActiveIndex(((index % count) + count) % count);
  }

  function openAddDrawer() {
    setEditing(null);
    setDrawerOpen(true);
  }

  function openEditDrawer(announcement: TeacherAnnouncement) {
    setEditing(announcement);
    setDrawerOpen(true);
  }

  async function saveAnnouncement(form: AnnouncementForm) {
    try {
      setSaving(true);

      const body = new FormData();
      body.set("description", form.description);
      if (form.imageFile) {
        body.set("image", form.imageFile);
      }

      const url = editing
        ? `/api/teacher/profile/announcements/${editing.id}`
        : "/api/teacher/profile/announcements";

      const response = await fetch(url, {
        method: editing ? "PUT" : "POST",
        body,
      });

      const payload = (await response.json()) as ApiResponse;

      if (!response.ok || payload.success === false) {
        throw new Error(readError(payload, "Failed to save announcement."));
      }

      setDrawerOpen(false);
      setEditing(null);
      await loadAnnouncements();
    } catch (error) {
      alert(
        error instanceof Error ? error.message : "Failed to save announcement."
      );
    } finally {
      setSaving(false);
    }
  }

  async function deleteAnnouncement(id: string) {
    if (!confirm("Delete this announcement?")) {
      return;
    }

    try {
      const response = await fetch(
        `/api/teacher/profile/announcements/${id}`,
        { method: "DELETE" }
      );
      const payload = (await response.json()) as ApiResponse;

      if (!response.ok || payload.success === false) {
        throw new Error(readError(payload, "Failed to delete announcement."));
      }

      await loadAnnouncements();
    } catch (error) {
      alert(
        error instanceof Error ? error.message : "Failed to delete announcement."
      );
    }
  }

  const active = useMemo(
    () => announcements[activeIndex],
    [announcements, activeIndex]
  );

  // On a public profile with no announcements, render nothing.
  if (isPublic && !loading && announcements.length === 0) {
    return null;
  }

  const limitReached = announcements.length >= MAX_TEACHER_ANNOUNCEMENTS;

  if (loading) {
    return (
      <div className="animate-pulse overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div className="space-y-1.5">
            <div className="h-4 w-28 rounded bg-slate-200" />
            <div className="h-3 w-48 rounded bg-slate-200" />
          </div>
          <div className="h-7 w-24 rounded-lg bg-slate-200" />
        </div>
        <div className="space-y-3 p-5">
          <div className="h-40 rounded-xl bg-slate-100" />
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-100">
            <Megaphone className="h-4 w-4 text-orange-600" />
          </div>
          <div>
            <h3 className="text-[16px] font-bold text-slate-900">Announcements</h3>
            <p className="mt-0.5 text-[14px] text-slate-500">
              Latest updates for students.
            </p>
          </div>
        </div>

        {!isPublic && (
          <button
            onClick={openAddDrawer}
            disabled={limitReached}
            title={
              limitReached
                ? `Limit of ${MAX_TEACHER_ANNOUNCEMENTS} announcements reached`
                : "Add announcement"
            }
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[#4D6C90] px-2.5 py-1 text-[12.5px] font-medium text-white transition hover:bg-[#3B5776] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
            Add
          </button>
        )}
      </div>

      {/* Body */}
      <div className="p-5">
        {!isPublic && (
          <p className="mb-3 text-[13px] text-slate-400">
            {announcements.length} / {MAX_TEACHER_ANNOUNCEMENTS} published
          </p>
        )}

        {announcements.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center">
            <Megaphone className="mx-auto h-8 w-8 text-slate-300" />
            <h4 className="mt-2 text-[15px] font-semibold text-slate-700">
              No announcements yet
            </h4>
            <p className="mt-1 text-[14px] text-slate-500">
              Post updates like new batches, schedule changes or exam notices.
            </p>
            {!isPublic && (
              <button
                onClick={openAddDrawer}
                className="mt-3 rounded-md bg-[#4D6C90] px-3 py-1.5 text-[13px] font-medium text-white transition hover:bg-[#3B5776]"
              >
                Add First Announcement
              </button>
            )}
          </div>
        ) : (
          active && (
            <div>
              {/* Slide */}
              <article className="overflow-hidden rounded-xl border border-slate-200">
                <div className="relative">
                  <SlideImage key={active.id} src={active.imageUrl} />

                  {announcements.length > 1 && (
                    <>
                      <button
                        type="button"
                        onClick={() => goTo(activeIndex - 1)}
                        aria-label="Previous announcement"
                        className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/85 p-1.5 text-slate-700 shadow-sm transition hover:bg-white"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => goTo(activeIndex + 1)}
                        aria-label="Next announcement"
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/85 p-1.5 text-slate-700 shadow-sm transition hover:bg-white"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>

                      <span className="absolute right-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold text-white">
                        {activeIndex + 1} / {announcements.length}
                      </span>
                    </>
                  )}
                </div>

                <div className="space-y-2 p-3.5">
                  <p className="max-h-32 overflow-y-auto whitespace-pre-line text-[14px] leading-6 text-slate-700">
                    {active.description}
                  </p>

                  <div className="flex items-center justify-between gap-3">
                    <time className="text-[12px] text-slate-400">
                      {new Date(active.createdAt).toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </time>

                    {!isPublic && (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          onClick={() => openEditDrawer(active)}
                          title="Edit announcement"
                          className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => deleteAnnouncement(active.id)}
                          title="Delete announcement"
                          className="rounded-md p-1 text-red-400 transition hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </article>

              {/* Carousel controls — manual prev / next only */}
              {announcements.length > 1 && (
                <div className="mt-3 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => goTo(activeIndex - 1)}
                    aria-label="Previous announcement"
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] font-medium text-slate-600 transition hover:bg-slate-50"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    Previous
                  </button>

                  <div className="flex items-center gap-1.5">
                    {announcements.map((announcement, index) => (
                      <button
                        key={announcement.id}
                        type="button"
                        onClick={() => goTo(index)}
                        aria-label={`Go to announcement ${index + 1}`}
                        aria-current={index === activeIndex}
                        className={`h-2 rounded-full transition-all ${
                          index === activeIndex
                            ? "w-5 bg-[#4D6C90]"
                            : "w-2 bg-slate-300 hover:bg-slate-400"
                        }`}
                      />
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => goTo(activeIndex + 1)}
                    aria-label="Next announcement"
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] font-medium text-slate-600 transition hover:bg-slate-50"
                  >
                    Next
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          )
        )}
      </div>

      {!isPublic && (
        <TeacherAnnouncementDrawer
          open={drawerOpen}
          saving={saving}
          initialValue={
            editing
              ? {
                  description: editing.description,
                  imageUrl: editing.imageUrl,
                }
              : undefined
          }
          onSave={saveAnnouncement}
          onClose={() => {
            setDrawerOpen(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
