"use client";

type MicrophoneLevelProps = {
  level: number;
};

export default function MicrophoneLevel({
  level,
}: MicrophoneLevelProps) {
  return (
    <div className="mt-6">

      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-slate-700">
          Microphone
        </span>

        <span className="text-xs text-slate-500">
          {Math.round(level)}%
        </span>
      </div>

      <div className="h-3 overflow-hidden rounded-full bg-slate-200">

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