"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Pencil, X } from "lucide-react";

import {
  DISPLAY_NAME_MAX_LENGTH,
  normalizeDisplayName,
  validateDisplayName,
} from "../../participant-identity.mjs";

/**
 * Student header profile: the student's current Jitsi display name (the one
 * the class sees) and, read-only, their registered name. "Change display
 * name" uses Jitsi's own display-name command (via `onChangeName`); the header
 * shows the new name only once Jitsi confirms it (`displayName` follows the
 * confirmed name). Display only: identity stays the participant ID.
 */
type StudentProfileMenuProps = {
  /** The logged-in student's registered name (server-built join info). Never editable here. */
  registeredName: string;
  /** The student's current Jitsi display name; null before the conference joins. */
  displayName: string | null;
  /** Changes this student's own Jitsi name; resolves with the confirmed name, rejects with a message. */
  onChangeName: (name: string) => Promise<string>;
  /** Start open (tests). */
  defaultOpen?: boolean;
  /** Start in the name editor (tests). */
  defaultEditing?: boolean;
};

const CONTROL =
  "inline-flex h-7 min-w-0 max-w-full items-center gap-2 rounded-[9px] bg-white/[0.07] px-2 text-xs font-semibold text-[#E2E8F0] ring-1 ring-inset ring-white/10 transition-colors hover:bg-white/[0.12] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/70 sm:h-8 sm:rounded-[10px] sm:text-[13px]";

function initialsOf(name: string) {
  const words = name.split(/\s+/).filter(Boolean);
  const first = Array.from(words[0] ?? "")[0] ?? "";
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] ?? "" : "";

  return (first + last).toUpperCase() || "?";
}

export default function StudentProfileMenu({
  registeredName,
  displayName,
  onChangeName,
  defaultOpen = false,
  defaultEditing = false,
}: StudentProfileMenuProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [editing, setEditing] = useState(defaultEditing);
  const [draft, setDraft] = useState(() => (defaultEditing ? displayName ?? registeredName : ""));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const errorId = useId();

  const current = displayName ?? registeredName;
  // The registered name is shown separately only when the Jitsi name differs.
  const showRegistered = normalizeDisplayName(current) !== normalizeDisplayName(registeredName);

  // Click outside / Escape closes the menu (not while a change is pending).
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!pending && rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setEditing(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) {
        setOpen(false);
        setEditing(false);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, pending]);

  const startEditing = () => {
    setDraft(current);
    setError(null);
    setEditing(true);
  };

  const submit = async () => {
    if (pending) return;

    const checked = validateDisplayName(draft);

    if (!checked.ok) {
      setError(checked.error);
      return;
    }

    setPending(true);
    setError(null);

    try {
      await onChangeName(checked.name);
      setEditing(false);
    } catch (failure) {
      // The current name stays as it is (only a confirmed change updates it).
      setError(failure instanceof Error && failure.message ? failure.message : "The name could not be changed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div ref={rootRef} className="relative min-w-0 max-w-full">
      <button
        type="button"
        className={CONTROL}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={showRegistered ? `${current} (Registered: ${registeredName})` : current}
        onClick={() => {
          setOpen((value) => !value);
          setEditing(false);
          setError(null);
        }}
      >
        <span
          aria-hidden="true"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#3B82F6]/30 text-[10px] font-bold text-[#DBEAFE] sm:h-6 sm:w-6"
        >
          {initialsOf(current)}
        </span>
        <span className="min-w-0 break-words text-left sm:max-w-[12rem] sm:truncate">{current}</span>
        <ChevronDown size={14} className="shrink-0 opacity-70" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Your profile"
          className="absolute right-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border border-[#1E293B] bg-[#172033] p-4 text-left shadow-2xl"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#94A3B8]">Display name</p>
          <p className="mt-1 break-words text-sm font-semibold text-[#F8FAFC]" data-testid="profile-display-name">
            {current}
          </p>

          {showRegistered && (
            <p className="mt-1 break-words text-xs text-[#94A3B8]" data-testid="profile-registered-name">
              Registered: <span className="text-[#CBD5E1]">{registeredName}</span>
            </p>
          )}

          {!showRegistered && (
            <p className="mt-1 text-xs text-[#94A3B8]">Your registered name</p>
          )}

          {editing ? (
            <form
              className="mt-3 space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label htmlFor={inputId} className="block text-xs font-medium text-[#CBD5E1]">
                New display name
              </label>
              <input
                id={inputId}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError(null);
                }}
                disabled={pending}
                autoFocus
                maxLength={DISPLAY_NAME_MAX_LENGTH * 2}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                className="w-full rounded-lg border border-[#334155] bg-[#0F172A] px-3 py-2 text-sm text-[#F8FAFC] outline-none focus:border-[#60A5FA] disabled:opacity-60"
              />
              <p className="text-[11px] text-[#64748B]">
                Shown to your class. Your registered name does not change.
              </p>
              {error && (
                <p id={errorId} role="alert" className="break-words text-xs text-[#FCA5A5]">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setError(null);
                  }}
                  disabled={pending}
                  className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-[#CBD5E1] hover:bg-white/[0.06] disabled:opacity-50"
                >
                  <X size={13} aria-hidden="true" />
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className="inline-flex items-center gap-1 rounded-lg bg-[#3B82F6] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#2563EB] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {pending ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                  {pending ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={startEditing}
              disabled={displayName === null}
              title={displayName === null ? "Available once you have joined the class" : undefined}
              className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-white/[0.07] px-3 py-2 text-xs font-semibold text-[#E2E8F0] ring-1 ring-inset ring-white/10 hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Pencil size={13} aria-hidden="true" />
              Change display name
            </button>
          )}
        </div>
      )}
    </div>
  );
}
