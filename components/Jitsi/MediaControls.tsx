"use client";

import { Video, VideoOff, Mic, MicOff } from "lucide-react";

type MediaControlsProps = {
  cameraEnabled: boolean;
  microphoneEnabled: boolean;

  onToggleCamera: () => void;
  onToggleMicrophone: () => void;
};

export default function MediaControls({
  cameraEnabled,
  microphoneEnabled,
  onToggleCamera,
  onToggleMicrophone,
}: MediaControlsProps) {
  return (
    <div className="mt-4 flex items-center justify-center gap-3">

      <button
        type="button"
        onClick={onToggleCamera}
        className={`flex h-10 w-10 items-center justify-center rounded-full transition ${
          cameraEnabled
            ? "bg-slate-800 text-slate-200 hover:bg-slate-700"
            : "bg-red-500 text-white hover:bg-red-600"
        }`}
      >
        {cameraEnabled ? <Video size={18} /> : <VideoOff size={18} />}
      </button>

      <button
        type="button"
        onClick={onToggleMicrophone}
        className={`flex h-10 w-10 items-center justify-center rounded-full transition ${
          microphoneEnabled
            ? "bg-slate-800 text-slate-200 hover:bg-slate-700"
            : "bg-red-500 text-white hover:bg-red-600"
        }`}
      >
        {microphoneEnabled ? <Mic size={18} /> : <MicOff size={18} />}
      </button>

    </div>
  );
}