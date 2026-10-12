"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

// Remembered per browser, like the classroom's other preferences.
const DISMISSED_STORAGE_KEY = "sl-classroom-orientation-hint-dismissed";

// A touch device held upright. The parent also only renders this on the
// portrait-phone layout (useClassroomViewport's isPhone), so a narrow desktop
// window (fine pointer) never shows it.
const PORTRAIT_TOUCH_QUERY = "(orientation: portrait) and (pointer: coarse)";

type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: "landscape") => Promise<void>;
};

function getLockableOrientation(): LockableOrientation | null {
  if (typeof screen === "undefined" || !screen.orientation) {
    return null;
  }

  const orientation = screen.orientation as LockableOrientation;

  return typeof orientation.lock === "function" ? orientation : null;
}

/**
 * Portrait phones: a slim tip under the classroom header suggesting landscape.
 * It takes its own row in the layout (never floats over the video, filmstrip,
 * bottom bar or sidebar), disappears in landscape, and a dismissal is
 * remembered in localStorage.
 *
 * "Rotate" is offered only where the Screen Orientation API has lock(). Most
 * browsers allow locking only in real fullscreen or an installed app, so a
 * refusal is expected: the tip then falls back to manual guidance.
 */
export default function OrientationHint() {
  // Hidden until storage and the media query are read (no flash on mount).
  const [dismissed, setDismissed] = useState(true);
  const [portraitTouch, setPortraitTouch] = useState(false);
  const [canLock, setCanLock] = useState(false);
  const [lockRefused, setLockRefused] = useState(false);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISSED_STORAGE_KEY) === "1");
    } catch {
      // Storage unavailable (private mode): show it for this visit.
      setDismissed(false);
    }

    setCanLock(getLockableOrientation() !== null);

    if (typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia(PORTRAIT_TOUCH_QUERY);
    const update = () => setPortraitTouch(query.matches);

    update();
    query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  }, []);

  if (dismissed || !portraitTouch) {
    return null;
  }

  const dismiss = () => {
    setDismissed(true);

    try {
      localStorage.setItem(DISMISSED_STORAGE_KEY, "1");
    } catch {
      // Private mode: hidden for this visit only.
    }
  };

  const rotate = async () => {
    const orientation = getLockableOrientation();

    if (!orientation?.lock) {
      setLockRefused(true);
      return;
    }

    try {
      // On success the page turns to landscape and this tip hides itself.
      await orientation.lock("landscape");
    } catch {
      // Not permitted here (no fullscreen, iOS, desktop mode...): manual guidance.
      setLockRefused(true);
    }
  };

  return (
    <aside
      aria-label="Orientation tip"
      className="flex shrink-0 items-center gap-2.5 border-b border-white/[0.06] bg-[#0E1B33] px-3 py-1.5"
    >
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#3B82F6]/15 text-[#93C5FD]"
      >
        {/* Phone turning sideways. */}
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="9" width="10" height="13" rx="2" />
          <path d="M8 19h2" />
          <path d="M14 3a7 7 0 0 1 7 7" />
          <path d="M21 6.5V10h-3.5" />
        </svg>
      </span>

      <p className="min-w-0 flex-1 text-xs leading-snug text-[#E2E8F0]" role="status" aria-live="polite">
        {lockRefused
          ? "Turn your phone sideways for the best classroom view."
          : "Rotate for the best classroom view."}
      </p>

      {canLock && !lockRefused && (
        <button
          type="button"
          onClick={() => void rotate()}
          className="inline-flex h-7 shrink-0 items-center rounded-lg px-2.5 text-xs font-semibold text-[#93C5FD] ring-1 ring-inset ring-[#60A5FA]/30 transition-colors hover:bg-[#3B82F6]/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/80"
        >
          Rotate
        </button>
      )}

      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss orientation tip"
        title="Don't show again"
        className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#94A3B8] transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/80"
      >
        <X size={15} aria-hidden="true" />
      </button>
    </aside>
  );
}
