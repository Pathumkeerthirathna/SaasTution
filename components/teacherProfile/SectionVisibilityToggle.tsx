"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

type ProfileSection = "qualification" | "achievements" | "subjects";

interface Props {
  section: ProfileSection;
  initialVisible: boolean;
  /** Called with the new value after a successful save. */
  onChange?: (visible: boolean) => void;
}

export default function SectionVisibilityToggle({
  section,
  initialVisible,
  onChange,
}: Props) {
  const [visible, setVisible] = useState(initialVisible);
  const [saving, setSaving] = useState(false);

  async function toggle() {
    if (saving) return;

    const next = !visible;

    // Optimistic update.
    setVisible(next);
    setSaving(true);

    try {
      const response = await fetch(
        "/api/teacher/profile/section-visibility",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ section, visible: next }),
        }
      );

      if (!response.ok) {
        throw new Error("Failed to update visibility.");
      }

      onChange?.(next);
    } catch (error) {
      // Revert on failure.
      setVisible(!next);
      alert(
        error instanceof Error
          ? error.message
          : "Failed to update section visibility."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={saving}
      role="switch"
      aria-checked={visible}
      title={
        visible
          ? "Section is visible on your public profile. Click to hide."
          : "Section is hidden from your public profile. Click to show."
      }
      className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-1 text-[13px] font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
    >
      {visible ? (
        <Eye className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <EyeOff className="h-3.5 w-3.5 text-slate-400" />
      )}

      <span className={visible ? "text-emerald-700" : "text-slate-400"}>
        {visible ? "Visible" : "Hidden"}
      </span>

      <span
        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
          visible ? "bg-emerald-500" : "bg-slate-300"
        }`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${
            visible ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}
