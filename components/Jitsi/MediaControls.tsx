"use client";

import { Video, VideoOff, Mic, MicOff } from "lucide-react";

type MediaControlsProps = {
  cameraEnabled: boolean;
  microphoneEnabled: boolean;

  onToggleCamera: () => void;
  onToggleMicrophone: () => void;

  /** Nothing to toggle until access is granted. */
  disabled?: boolean;
};

const buttonClass = (on: boolean) =>
  `flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/70 disabled:cursor-not-allowed disabled:opacity-45 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 ${
    on
      ? "bg-white/[0.06] text-slate-200 ring-1 ring-inset ring-white/[0.08] hover:bg-white/[0.1]"
      : "bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-500/35 hover:bg-red-500/25"
  }`;

export default function MediaControls({
  cameraEnabled,
  microphoneEnabled,
  onToggleCamera,
  onToggleMicrophone,
  disabled = false,
}: MediaControlsProps) {
  return (
    <div className="flex shrink-0 items-center gap-2">

      <button
        type="button"
        onClick={onToggleCamera}
        disabled={disabled}
        aria-pressed={!cameraEnabled}
        aria-label={cameraEnabled ? "Turn camera off" : "Turn camera on"}
        title={cameraEnabled ? "Turn camera off" : "Turn camera on"}
        className={buttonClass(cameraEnabled)}
      >
        {cameraEnabled ? <Video size={17} /> : <VideoOff size={17} />}
      </button>

      <button
        type="button"
        onClick={onToggleMicrophone}
        disabled={disabled}
        aria-pressed={!microphoneEnabled}
        aria-label={microphoneEnabled ? "Mute microphone" : "Unmute microphone"}
        title={microphoneEnabled ? "Mute microphone" : "Unmute microphone"}
        className={buttonClass(microphoneEnabled)}
      >
        {microphoneEnabled ? <Mic size={17} /> : <MicOff size={17} />}
      </button>

    </div>
  );
}
