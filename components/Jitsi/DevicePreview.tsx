"use client";

import type { RefObject } from "react";
import { Loader2, VideoOff } from "lucide-react";

type DevicePreviewProps = {
  videoRef: RefObject<HTMLVideoElement>;
  cameraEnabled: boolean;
  userName?: string;
  /** Before access is granted the preview explains itself instead of showing black. */
  permissionGranted?: boolean;
  /** Access is being requested right now. */
  checking?: boolean;
};

export default function DevicePreview({
  videoRef,
  cameraEnabled,
  userName,
  permissionGranted = true,
  checking = false,
}: DevicePreviewProps) {
  const initials =
    userName
      ?.split(" ")
      .map((x) => x[0])
      .join("")
      .toUpperCase() ?? "U";

  const cameraOff = permissionGranted && !cameraEnabled;

  return (
    // 16:9 at any width, but never taller than about half the screen (short
    // laptops, landscape phones): the width is capped instead of cropping.
    <div className="relative mx-auto aspect-video w-full max-w-[calc(48dvh*16/9)] overflow-hidden rounded-xl border border-white/[0.08] bg-[#0A1120]">

      {/* Always mounted: the hook attaches the stream to this element. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`h-full w-full object-cover ${
          cameraEnabled ? "block" : "hidden"
        }`}
      />

      {cameraOff && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#2563EB] text-lg font-semibold text-white sm:h-16 sm:w-16 sm:text-xl">
            {initials}
          </div>

          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <VideoOff size={13} aria-hidden="true" />
            Camera is off
          </span>
        </div>
      )}

      {!permissionGranted && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#0A1120] px-4 text-center">
          {checking ? (
            <>
              <Loader2 size={20} className="animate-spin text-[#60A5FA]" aria-hidden="true" />
              <span className="text-xs text-slate-300">Starting camera…</span>
            </>
          ) : (
            <>
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.05] text-slate-400">
                <VideoOff size={18} aria-hidden="true" />
              </span>
              <span className="max-w-[16rem] text-xs leading-snug text-slate-400">
                Your camera preview appears here after you allow access.
              </span>
            </>
          )}
        </div>
      )}

    </div>
  );
}
