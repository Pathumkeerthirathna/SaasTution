"use client";

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
    <div className="mt-6 flex items-center justify-center gap-5">

      <button
        type="button"
        onClick={onToggleCamera}
        className={`flex h-14 w-14 items-center justify-center rounded-full text-2xl transition ${
          cameraEnabled
            ? "bg-slate-200 hover:bg-slate-300"
            : "bg-red-500 text-white hover:bg-red-600"
        }`}
      >
        {cameraEnabled ? "📷" : "🚫📷"}
      </button>

      <button
        type="button"
        onClick={onToggleMicrophone}
        className={`flex h-14 w-14 items-center justify-center rounded-full text-2xl transition ${
          microphoneEnabled
            ? "bg-slate-200 hover:bg-slate-300"
            : "bg-red-500 text-white hover:bg-red-600"
        }`}
      >
        {microphoneEnabled ? "🎤" : "🔇"}
      </button>

    </div>
  );
}