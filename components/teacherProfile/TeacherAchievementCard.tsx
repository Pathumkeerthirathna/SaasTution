"use client";

import { useEffect, useState } from "react";

import {
  Award,
  Pencil,
  Plus,
  Trash2,
  Trophy,
} from "lucide-react";
import { Achievement, AchievementForm } from "@/types/teacherProfileTypes/achievement/achievement-types";
import TeacherAchievementDrawer from "./achievement/TeacherAchievementDrawer";
import SectionVisibilityToggle from "./SectionVisibilityToggle";

interface Props{
  teacherId:string;
  isPublic?: boolean;
  sectionVisible?: boolean;
}

export default function TeacherAchievementCard({
  teacherId,
  isPublic,
  sectionVisible = true
}:Props) {

  const [visible, setVisible] = useState(sectionVisible);

  const [achievements, setAchievements] =
    useState<Achievement[]>([]);

  const [loading, setLoading] =
    useState(true);

  const [saving, setSaving] =
    useState(false);

  const [drawerOpen, setDrawerOpen] =
    useState(false);

  const [editingAchievement,
    setEditingAchievement] =
    useState<Achievement | null>(null);

  useEffect(() => {

    async function loadAchievements() {

      try {

        setLoading(true);

        const response = await fetch(
          `/api/teacher/profile/achievements?teacherId=${teacherId}`
        );

        if (!response.ok) {
          throw new Error(
            "Failed to load achievements."
          );
        }

        const data: Achievement[] =
          await response.json();

        setAchievements(data);

      } catch (error) {

        console.error(error);

      } finally {

        setLoading(false);

      }

    }

    loadAchievements();

  }, []);

  async function RefreshAchievements() {

      try {

        setLoading(true);

        const response = await fetch(
          `/api/teacher/profile/achievements?teacherId=${teacherId}`
        );

        if (!response.ok) {
          throw new Error(
            "Failed to load achievements."
          );
        }

        const data: Achievement[] =
          await response.json();

        setAchievements(data);

      } catch (error) {

        console.error(error);

      } finally {

        setLoading(false);

      }

    }

  

  function openAddDrawer() {

    setEditingAchievement(null);

    setDrawerOpen(true);

  }

  function openEditDrawer(
    achievement: Achievement
  ) {

    setEditingAchievement(
      achievement
    );

    setDrawerOpen(true);

  }

  async function saveAchievement(
    form: AchievementForm
  ) {

    try {

      setSaving(true);

      const editing =
        editingAchievement != null;

      const url = editing
        ? `/api/teacher/profile/achievements/${editingAchievement.id}`
        : "/api/teacher/profile/achievements";

      const method =
        editing ? "PUT" : "POST";

      const response =
        await fetch(url, {

          method,

          headers: {
            "Content-Type":
              "application/json",
          },

          body: JSON.stringify(form),

        });

      if (!response.ok) {

        const error =
          await response.json();

        throw new Error(
          error.message
        );

      }

      setDrawerOpen(false);

      setEditingAchievement(
        null
      );

      await RefreshAchievements();

    }
    catch (error) {

      console.error(error);

      alert(
        error instanceof Error
          ? error.message
          : "Failed to save achievement."
      );

    }
    finally {

      setSaving(false);

    }

  }

  async function deleteAchievement(
    id: string
  ) {

    if (
      !confirm(
        "Delete this achievement?"
      )
    ) {
      return;
    }

    try {

      const response =
        await fetch(
          `/api/teacher/profile/achievements/${id}`,
          {
            method: "DELETE",
          }
        );

      if (!response.ok) {

        const error =
          await response.json();

        throw new Error(
          error.message
        );

      }

      await RefreshAchievements();

    }
    catch (error) {

      console.error(error);

      alert(
        error instanceof Error
          ? error.message
          : "Failed to delete achievement."
      );

    }

  }

  if (isPublic && !visible) {
    return null;
  }

  if (loading) {
    return (
      <div className="animate-pulse overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div className="space-y-1.5">
            <div className="h-4 w-40 rounded bg-slate-200" />
            <div className="h-3 w-56 rounded bg-slate-200" />
          </div>
          <div className="h-7 w-32 rounded-lg bg-slate-200" />
        </div>

        <div className="space-y-3 p-5">
          <div className="h-20 rounded-xl bg-slate-100" />
          <div className="h-20 rounded-xl bg-slate-100" />
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
            Achievements &amp; Awards
          </h3>

          <p className="mt-0.5 text-[14px] text-slate-500">
            Showcase your accomplishments, recognitions and teaching milestones.
          </p>

        </div>

          {isPublic ? null : (
          <div className="flex shrink-0 items-center gap-2">
            <SectionVisibilityToggle
              section="achievements"
              initialVisible={visible}
              onChange={setVisible}
            />
            <button
              onClick={openAddDrawer}
              className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-2.5 py-1.5 text-[14px] font-medium text-white transition hover:bg-orange-600"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Achievement
            </button>
          </div>
        )}

      </div>

      {/* Body */}

      <div className="p-5">

        {loading ? (

          <div className="py-8 text-center text-[14px] text-slate-400">
            Loading achievements...
          </div>

        ) : achievements.length === 0 ? (

          <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center">

            <Trophy className="mx-auto h-8 w-8 text-slate-300" />

            <h4 className="mt-2 text-[16px] font-semibold text-slate-700">
              No achievements yet
            </h4>

            <p className="mt-1 text-[14px] text-slate-500">
              Add awards, recognitions or milestones to increase trust among students and parents.
            </p>

            <button
              onClick={openAddDrawer}
              className="mt-3 rounded-lg bg-orange-500 px-3 py-1.5 text-[14px] font-medium text-white transition hover:bg-orange-600"
            >
              Add First Achievement
            </button>

          </div>

        ) : (

          <>
            <div className="grid gap-3 md:grid-cols-2">

              {achievements.map((achievement) => (

                <div
                  key={achievement.id}
                  className="group rounded-lg border border-slate-200 bg-white p-3.5 transition hover:border-orange-200 hover:shadow-sm"
                >

                  <div className="flex items-start gap-3">

                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-100">

                      <Trophy className="h-4 w-4 text-orange-600" />

                    </div>

                    <div className="min-w-0 flex-1">

                      <div className="flex items-start justify-between gap-2">

                        <div className="flex flex-wrap items-center gap-2">

                          <h4 className="text-[15px] font-semibold text-slate-900">
                            {achievement.title}
                          </h4>

                          {achievement.year && (

                            <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[12px] font-semibold text-orange-700">
                              {achievement.year}
                            </span>

                          )}

                        </div>

                        {isPublic? null  : (<div className="flex shrink-0 items-center gap-0.5">

                          <button
                            onClick={() =>
                              openEditDrawer(
                                achievement
                              )
                            }
                            title="Edit Achievement"
                            className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                          >

                            <Pencil className="h-3.5 w-3.5" />

                          </button>

                          <button
                            onClick={() =>
                              deleteAchievement(
                                achievement.id
                              )
                            }
                            title="Delete Achievement"
                            className="rounded-md p-1 text-red-400 transition hover:bg-red-50 hover:text-red-600"
                          >

                            <Trash2 className="h-3.5 w-3.5" />

                          </button>

                        </div>)}

                      </div>

                      {achievement.description && (

                        <p className="mt-1 whitespace-pre-line text-[14px] leading-5 text-slate-600">
                          {achievement.description}
                        </p>

                      )}

                    </div>

                  </div>

                </div>

              ))}

            </div>

            {/* Summary */}

            <div className="mt-4 rounded-xl border border-orange-100 bg-gradient-to-r from-orange-50 to-amber-50 p-3">

              <div className="flex items-center gap-2.5">

                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-100">

                  <Award className="h-4 w-4 text-orange-600" />

                </div>

                <div>

                  <p className="text-[13px] text-slate-500">
                    Total Achievements
                  </p>

                  <h4 className="text-[18px] font-bold leading-tight text-slate-900">
                    {achievements.length}
                  </h4>

                </div>

              </div>

              <p className="mt-2 text-[14px] leading-5 text-slate-700">
                Awards, recognitions and accomplishments shown here also appear on your public profile, helping students and parents build confidence in your teaching experience.
              </p>

            </div>

          </>

        )}

      </div>
        <TeacherAchievementDrawer
          open={drawerOpen}
          saving={saving}
          initialValue={
            editingAchievement
              ? {
                  title:
                    editingAchievement.title,

                  description:
                    editingAchievement.description ??
                    "",

                  year:
                    editingAchievement.year ??
                    "",
                }
              : undefined
          }
          onSave={saveAchievement}
          onClose={() => {

            setDrawerOpen(false);

            setEditingAchievement(
              null
            );

          }}
        />
          

    </div>

    );
}

    
      