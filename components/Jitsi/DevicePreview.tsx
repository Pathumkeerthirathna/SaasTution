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

          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-blue-600 text-2xl font-semibold text-white">
            {initials}
          </div>

        </div>
      )}

    </div>
  );
}