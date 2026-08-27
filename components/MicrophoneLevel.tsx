"use client";

type MicrophoneLevelProps = {
  level: number;
};

export default function MicrophoneLevel({
  level,
}: MicrophoneLevelProps) {
  return (
    <div className="mt-4">

      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-slate-400">
          Microphone
        </span>

        <span className="text-xs text-slate-500">
          {Math.round(level)}%
        </span>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">

        <div
          className="h-full rounded-full bg-green-500 transition-all duration-75"
          style={{
            width: `${level}%`,
          }}
        />

      </div>

    </div>
  );
}