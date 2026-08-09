"use client";

export default function SessionEnded() {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-6">
      <h2 className="text-lg font-bold text-amber-800">
        Session Ended
      </h2>

      <p className="mt-2 text-sm text-amber-700">
        This classroom session has ended.
      </p>
    </div>
  );
}