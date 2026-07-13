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

interface Props{
  teacherId:string;
  isPublic?: boolean;
}

export default function TeacherAchievementCard({
  teacherId,
  isPublic
}:Props) {

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

  if (loading) {
    return (
      <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 shadow-sm animate-pulse">
        <div className="flex flex-col gap-6 lg:flex-row lg:justify-between">

          {/* Left */}
          <div className="flex gap-5">

            {/* Avatar */}
            <div className="h-28 w-28 rounded-full bg-slate-200" />

            {/* Details */}
            <div className="space-y-4">
              <div className="h-8 w-64 rounded bg-slate-200" />
              <div className="h-5 w-48 rounded bg-slate-200" />
              <div className="h-4 w-72 rounded bg-slate-200" />
              <div className="h-4 w-56 rounded bg-slate-200" />

              <div className="flex gap-4">
                <div className="h-4 w-32 rounded bg-slate-200" />
                <div className="h-4 w-32 rounded bg-slate-200" />
              </div>
            </div>
          </div>

          {/* Right */}
          <div className="space-y-4">
            <div className="h-11 w-40 rounded-xl bg-slate-200" />
            <div className="h-4 w-24 rounded bg-slate-200" />

            <div className="flex gap-2">
              <div className="h-8 w-20 rounded-full bg-slate-200" />
              <div className="h-8 w-20 rounded-full bg-slate-200" />
              <div className="h-8 w-20 rounded-full bg-slate-200" />
            </div>
          </div>

        </div>
      </div>
    );
  }

  return (

    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">

      {/* Header */}

      <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">

        <div>

          <h3 className="text-lg font-bold text-slate-900">
            Achievements & Awards
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            Showcase your accomplishments,
            recognitions and teaching milestones.
          </p>

        </div>

          {isPublic ? null : (<button
          onClick={openAddDrawer}
          className="flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-orange-600"
        >

          <Plus className="h-4 w-4" />

          Add Achievement

        </button>)}

        

      </div>

      {/* Body */}

      <div className="p-6">

        {loading ? (

          <div className="py-12 text-center text-slate-400">
            Loading achievements...
          </div>

        ) : achievements.length === 0 ? (

          <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center">

            <Trophy className="mx-auto h-12 w-12 text-slate-300" />

            <h4 className="mt-4 text-lg font-semibold text-slate-700">
              No achievements yet
            </h4>

            <p className="mt-2 text-sm text-slate-500">
              Add awards, recognitions or
              milestones to increase trust
              among students and parents.
            </p>

            <button
              onClick={openAddDrawer}
              className="mt-5 rounded-xl bg-orange-500 px-5 py-2.5 font-medium text-white transition hover:bg-orange-600"
            >
              Add First Achievement
            </button>

          </div>

        ) : (

          <>
            <div className="space-y-5">

              {achievements.map((achievement) => (

                <div
                  key={achievement.id}
                  className="group rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-orange-200 hover:shadow-md"
                >

                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">

                    {/* Left */}

                    <div className="flex gap-4">

                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-orange-100">

                        <Trophy className="h-6 w-6 text-orange-600" />

                      </div>

                      <div>

                        <div className="flex flex-wrap items-center gap-3">

                          <h4 className="text-lg font-semibold text-slate-900">
                            {achievement.title}
                          </h4>

                          {achievement.year && (

                            <span className="rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-700">
                              {achievement.year}
                            </span>

                          )}

                        </div>

                        {achievement.description && (

                          <p className="mt-2 text-sm leading-7 text-slate-600 whitespace-pre-line">
                            {achievement.description}
                          </p>

                        )}

                      </div>

                    </div>

                    {/* Actions */}

                    {isPublic? null  : (<div className="flex items-center gap-2">

                      <button
                        onClick={() =>
                          openEditDrawer(
                            achievement
                          )
                        }
                        title="Edit Achievement"
                        className="rounded-xl border border-slate-200 p-2 text-slate-600 transition hover:bg-slate-50"
                      >

                        <Pencil className="h-4 w-4" />

                      </button>

                      <button
                        onClick={() =>
                          deleteAchievement(
                            achievement.id
                          )
                        }
                        title="Delete Achievement"
                        className="rounded-xl border border-red-200 p-2 text-red-500 transition hover:bg-red-50"
                      >

                        <Trash2 className="h-4 w-4" />

                      </button>

                    </div>)}

                    

                  </div>

                </div>

              ))}

            </div>

            {/* Summary */}

            <div className="mt-6 rounded-2xl border border-orange-100 bg-gradient-to-r from-orange-50 to-amber-50 p-5">

              <div className="flex items-center gap-3">

                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-orange-100">

                  <Award className="h-6 w-6 text-orange-600" />

                </div>

                <div>

                  <p className="text-sm text-slate-500">
                    Total Achievements
                  </p>

                  <h4 className="text-xl font-bold text-slate-900">
                    {achievements.length}
                  </h4>

                </div>

              </div>

              <p className="mt-4 text-sm leading-6 text-slate-700">
                Awards, recognitions and accomplishments
                displayed here will also appear on your
                public profile, helping students and
                parents build confidence in your teaching
                experience.
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

    
      