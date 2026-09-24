"use client";

import type { RefObject } from "react";

type DevicePreviewProps = {
  videoRef: RefObject<HTMLVideoElement>;
  cameraEnabled: boolean;
  userName?: string;
};

export default function DevicePreview({
  videoRef,
  cameraEnabled,
  userName,
}: DevicePreviewProps) {
  const initials =
    userName
      ?.split(" ")
      .map((x) => x[0])
      .join("")
      .toUpperCase() ?? "U";

  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-700 bg-slate-900">

      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`aspect-video w-full object-cover ${
          cameraEnabled ? "block" : "hidden"
        }`}
      />

      {!cameraEnabled && (
        <div className="flex aspect-video items-center justify-center">

          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-600 text-lg font-semibold text-white sm:h-20 sm:w-20 sm:text-2xl">
            {initials}
          </div>

        </div>
      )}

    </div>
  );
}