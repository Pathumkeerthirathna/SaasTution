"use client";

type MicrophoneLevelProps = {
  level: number;
};

export default function MicrophoneLevel({
  level,
}: MicrophoneLevelProps) {
  const value = Math.max(0, Math.min(100, Math.round(level)));

  return (
    <div className="min-w-0 flex-1">

      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-400">
          Microphone level
        </span>

        <span className="text-xs tabular-nums text-slate-500">
          {value}%
        </span>
      </div>

      <div
        role="meter"
        aria-label="Microphone level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]"
      >

        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-green-400 transition-[width] duration-75"
          style={{
            width: `${level}%`,
          }}
        />

      </div>

    </div>
  );
}
