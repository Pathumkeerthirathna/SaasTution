"use client";

import { useEffect, useState } from "react";
import { Info, X } from "lucide-react";

export const SCREEN_SHARE_NOTICE_MESSAGE =
  "Screen sharing is available on supported desktop browsers. Please join this classroom using a computer to share your screen.";

type NavigatorLike = {
  mediaDevices?: { getDisplayMedia?: unknown } | null;
} | null | undefined;

/**
 * Browser capability, not device type: true when this browser exposes
 * getDisplayMedia (desktop browsers, and any tablet/phone browser that has it).
 * It says nothing about whether a capture will succeed; Jitsi's own Share
 * Screen button still handles permissions and failures.
 */
export function canShareScreen(nav: NavigatorLike): boolean {
  return typeof nav?.mediaDevices?.getDisplayMedia === "function";
}

/**
 * A compact, dismissible tip in the classroom header (beside Fullscreen), shown
 * to teachers and students alike only when the browser cannot share a screen.
 * It sits in the header's normal flow, so it never floats over the meeting; once
 * closed it renders nothing and leaves no space behind.
 *
 * The dismissal is held only in component state: it lasts for this classroom
 * visit. JitsiClassroom keys this component by session ID, so another
 * classroom session starts with the notice shown again. Nothing is stored.
 */
export default function ScreenShareNotice() {
  // Unknown until mounted (navigator is client-only): render nothing, so the
  // server HTML and first client render match and supported browsers never
  // flash the notice.
  const [supported, setSupported] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setSupported(canShareScreen(typeof navigator === "undefined" ? null : navigator));
  }, []);

  if (supported !== false || dismissed) {
    return null;
  }

  return <ScreenShareNoticeView onDismiss={() => setDismissed(true)} />;
}

/** The notice itself: info icon, message and close button. */
export function ScreenShareNoticeView({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="note"
      aria-label="Screen sharing availability"
      className="flex min-w-0 max-w-full items-center gap-1.5 rounded-[9px] bg-white/[0.05] py-1 pl-2 pr-0.5 ring-1 ring-inset ring-white/[0.08] sm:max-w-[22rem] sm:rounded-[10px]"
    >
      <Info size={13} aria-hidden="true" className="shrink-0 text-[#93C5FD]" />

      <p className="min-w-0 flex-1 text-[11px] leading-tight text-[#CBD5E1]">
        {SCREEN_SHARE_NOTICE_MESSAGE}
      </p>

      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss screen sharing notice"
        title="Dismiss"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#94A3B8] transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/80"
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
