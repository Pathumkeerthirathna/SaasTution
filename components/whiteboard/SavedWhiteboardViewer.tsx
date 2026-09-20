"use client";

import { useEffect, useState } from "react";
import { PenTool, X } from "lucide-react";

import WhiteboardCanvasLazy from "./WhiteboardCanvasLazy";
import type { WhiteboardDetail } from "@/types/whiteboard";

type Props = {
  lectureId: string;
  whiteboardId: string;
  title: string;
  onClose: () => void;
};

/** Read-only, full-screen view of one saved whiteboard (student). */
export default function SavedWhiteboardViewer({ lectureId, whiteboardId, title, onClose }: Props) {
  const [board, setBoard] = useState<WhiteboardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch(`/api/student/lectures/${lectureId}/whiteboards/${whiteboardId}`);
        const payload = (await response.json().catch(() => null)) as {
          data?: { whiteboard: WhiteboardDetail };
          error?: { message?: string };
        } | null;

        if (!response.ok || !payload?.data) {
          throw new Error(payload?.error?.message ?? "Could not open the whiteboard.");
        }

        if (!cancelled) {
          setBoard(payload.data.whiteboard);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not open the whiteboard.");
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [lectureId, whiteboardId]);

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
            <PenTool size={15} />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-slate-900">{title}</h2>
            <p className="text-[11px] text-slate-500">View only</p>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-[12.5px] font-medium text-slate-700 hover:bg-slate-50"
        >
          <span className="inline-flex items-center gap-1.5">
            <X size={14} /> Close
          </span>
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {error ? (
          <p className="p-6 text-center text-[13px] text-red-600">{error}</p>
        ) : !board ? (
          <p className="p-6 text-center text-[13px] text-slate-500">Loading whiteboard...</p>
        ) : (
          <WhiteboardCanvasLazy initialScene={board.data} readOnly />
        )}
      </div>
    </div>
  );
}
