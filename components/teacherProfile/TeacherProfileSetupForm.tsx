"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TeacherTitle } from "@prisma/client";
import { Check, Link2, Loader2, Sparkles, X } from "lucide-react";
import {
  TEACHER_TITLE_LABELS,
  TEACHER_TITLE_OPTIONS,
} from "@/lib/teacher-title";

interface Props {
  teacherName: string;
  suggestedSlug: string;
  slugAvailable: boolean;
  alternatives: string[];
}

function normalizeSlug(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
}

export default function TeacherProfileSetupForm({
  teacherName,
  suggestedSlug,
  slugAvailable,
  alternatives,
}: Props) {
  const router = useRouter();

  const [title, setTitle] = useState<TeacherTitle>("MR");
  const [displayName, setDisplayName] = useState(teacherName);

  const [slug, setSlug] = useState(
    slugAvailable ? suggestedSlug : alternatives[0] ?? suggestedSlug
  );
  const [slugTouched, setSlugTouched] = useState(false);

  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(
    slugAvailable || alternatives.length > 0 ? true : null
  );
  const [checkMessage, setCheckMessage] = useState(
    slugAvailable
      ? "This profile link is available."
      : alternatives.length > 0
      ? "This profile link is available."
      : ""
  );

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  function handleDisplayNameChange(value: string) {
    setDisplayName(value);

    if (!slugTouched) {
      const derived = normalizeSlug(value);
      setSlug(derived);
      setAvailable(null);
      setCheckMessage("");
    }
  }

  function selectAlternative(candidate: string) {
    setSlug(candidate);
    setSlugTouched(true);
    setAvailable(true);
    setCheckMessage("This profile link is available.");
    setSubmitError("");
  }

  async function checkAvailability(value: string) {
    if (!value.trim()) {
      setAvailable(false);
      setCheckMessage("Please enter a profile link.");
      return;
    }

    try {
      setChecking(true);

      const res = await fetch(
        `/api/teacher/profile/check-slug?slug=${encodeURIComponent(value)}`
      );

      const data = await res.json();

      setAvailable(Boolean(data.available));
      setCheckMessage(
        data.available
          ? "This profile link is available."
          : "This profile link is already taken."
      );
    } catch {
      setAvailable(false);
      setCheckMessage("Could not verify this link right now.");
    } finally {
      setChecking(false);
    }
  }

  async function handleSubmit() {
    if (
      !displayName.trim() ||
      !slug.trim() ||
      available === false ||
      submitting ||
      checking
    ) {
      return;
    }

    try {
      setSubmitting(true);
      setSubmitError("");

      const res = await fetch("/api/teacher/profile/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, displayName, slug }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(
          data?.message ?? "Failed to create your public profile."
        );
      }

      router.refresh();
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : "Failed to create your public profile."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {/* Header */}
        <div className="border-b border-slate-100 bg-slate-50 px-6 py-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#4D6C90]/10">
              <Sparkles className="h-5 w-5 text-[#4D6C90]" />
            </div>

            <div>
              <h1 className="text-[18px] font-bold text-slate-900">
                Set Up Your Public Profile
              </h1>

              <p className="mt-1 text-[14px] leading-relaxed text-slate-600">
                Before students and parents can find you, let&apos;s create
                your public teacher profile. Choose how your name should
                appear and confirm your profile link.
              </p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="space-y-4 px-6 py-6">
          <div className="grid grid-cols-3 gap-3">
            {/* Title */}
            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Title
              </label>

              <select
                value={title}
                onChange={(e) =>
                  setTitle(e.target.value as TeacherTitle)
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-[#4D6C90]"
              >
                {TEACHER_TITLE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {TEACHER_TITLE_LABELS[option]}
                  </option>
                ))}
              </select>
            </div>

            {/* Display Name */}
            <div className="col-span-2">
              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Display Name
              </label>

              <input
                value={displayName}
                onChange={(e) => handleDisplayNameChange(e.target.value)}
                placeholder="Your full name"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-[#4D6C90]"
              />
            </div>
          </div>

          {/* Slug */}
          <div>
            <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
              Public Profile Link
            </label>

            <div className="flex overflow-hidden rounded-lg border border-slate-300 focus-within:border-[#4D6C90]">
              <div className="flex items-center gap-1.5 bg-slate-100 px-3 py-2 text-[13px] text-slate-500">
                <Link2 className="h-3.5 w-3.5 shrink-0" />
                slclassroom.live/
              </div>

              <input
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(normalizeSlug(e.target.value));
                  setAvailable(null);
                  setCheckMessage("");
                  setSubmitError("");
                }}
                onBlur={() => checkAvailability(slug)}
                className="flex-1 px-3 py-2 text-[13px] outline-none"
                placeholder="your-profile-link"
              />
            </div>

            <div className="mt-1.5 min-h-[18px] text-[12px]">
              {checking ? (
                <span className="flex items-center gap-1.5 text-slate-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Checking availability...
                </span>
              ) : checkMessage ? (
                <span
                  className={`flex items-center gap-1.5 ${
                    available ? "text-emerald-600" : "text-red-600"
                  }`}
                >
                  {available ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                  {checkMessage}
                </span>
              ) : null}
            </div>
          </div>

          {/* Suggested alternatives */}
          {alternatives.length > 0 && (
            <div>
              <p className="mb-2 text-[12.5px] font-semibold uppercase tracking-wide text-slate-500">
                {suggestedSlug} is taken — try one of these instead
              </p>

              <div className="flex flex-wrap gap-2">
                {alternatives.map((alt) => (
                  <button
                    key={alt}
                    type="button"
                    onClick={() => selectAlternative(alt)}
                    className={`rounded-full border px-3 py-1 text-[12.5px] font-medium transition ${
                      slug === alt
                        ? "border-[#4D6C90] bg-[#4D6C90]/5 text-[#4D6C90]"
                        : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    {alt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {submitError && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-600">
              {submitError}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-slate-100 bg-slate-50 px-6 py-4">
          <button
            type="button"
            disabled={
              !displayName.trim() ||
              !slug.trim() ||
              available === false ||
              submitting ||
              checking
            }
            onClick={handleSubmit}
            className="rounded-lg bg-[#4D6C90] px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition hover:bg-[#3B5776] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Creating Your Profile..." : "Create My Profile"}
          </button>
        </div>
      </div>
    </div>
  );
}
