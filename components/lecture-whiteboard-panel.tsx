"use client";

import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { PenTool, Plus, X } from "lucide-react";

import WhiteboardEditor from "@/components/whiteboard/WhiteboardEditor";
import { formatWhiteboardDate } from "@/components/whiteboard/scene-utils";
import type { WhiteboardDetail, WhiteboardListItem } from "@/types/whiteboard";

type Editing = { key: number; board: WhiteboardDetail | null };

async function readApiError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return payload?.error?.message ?? fallback;
}

/** Saved whiteboards of one lecture: list, open/continue editing, create, delete. */
export function LectureWhiteboardPanel(props: { lectureId: string; onChanged?: () => void }) {
  const { lectureId, onChanged } = props;

  const [items, setItems] = useState<WhiteboardListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const response = await fetch(`/api/lectures/${lectureId}/whiteboards`);

      if (!response.ok) {
        throw new Error(await readApiError(response, "Could not load whiteboards."));
      }

      const payload = (await response.json()) as { data: WhiteboardListItem[] };
      setItems(payload.data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load whiteboards.");
    } finally {
      setLoading(false);
    }
  }, [lectureId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openBoard(item: WhiteboardListItem) {
    setOpeningId(item.id);

    try {
      const response = await fetch(`/api/lectures/${lectureId}/whiteboards/${item.id}`);

      if (!response.ok) {
        throw new Error(await readApiError(response, "Could not open the whiteboard."));
      }

      const payload = (await response.json()) as { data: { whiteboard: WhiteboardDetail } };
      setEditing({ key: Date.now(), board: payload.data.whiteboard });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open the whiteboard.");
    } finally {
      setOpeningId(null);
    }
  }

  async function deleteBoard(item: WhiteboardListItem) {
    if (!window.confirm(`Delete the whiteboard "${item.title}"?`)) {
      return;
    }

    setDeletingId(item.id);

    try {
      const response = await fetch(`/api/lectures/${lectureId}/whiteboards/${item.id}`, { method: "DELETE" });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Could not delete the whiteboard."));
      }

      toast.success("Whiteboard deleted.");
      await load();
      onChanged?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the whiteboard.");
    } finally {
      setDeletingId(null);
    }
  }

  function closeEditor() {
    setEditing(null);
    void load();
    onChanged?.();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-slate-900">Whiteboards</p>

        <button
          type="button"
          onClick={() => setEditing({ key: Date.now(), board: null })}
          className="inline-flex items-center gap-1.5 rounded-md bg-[#4D6C90] px-3 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-[#3B5776]"
        >
          <Plus size={14} />
          New Whiteboard
        </button>
      </div>

      {loading ? (
        <div className="h-24 animate-pulse rounded-lg bg-slate-100" />
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center">
          <PenTool className="mx-auto h-7 w-7 text-slate-300" />
          <p className="mt-2 text-[13px] font-semibold text-slate-700">No whiteboards yet</p>
          <p className="mt-1 text-[12px] text-slate-500">
            Draw during a live class and save it, or create one here.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item, index) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-semibold text-slate-900">{item.title}</p>
                <p className="text-[11.5px] text-slate-500">
                  Whiteboard {index + 1} · Created {formatWhiteboardDate(item.createdAt)}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void openBoard(item)}
                  disabled={openingId === item.id}
                  className="rounded-md border border-slate-300 px-3 py-1 text-[12px] font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                >
                  {openingId === item.id ? "Opening..." : "Open"}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteBoard(item)}
                  disabled={deletingId === item.id}
                  className="rounded-md border border-red-200 px-3 py-1 text-[12px] font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-60"
                >
                  {deletingId === item.id ? "Deleting..." : "Delete"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <div className="fixed inset-0 z-[70] flex flex-col bg-white">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-700">
                <PenTool size={15} />
              </span>
              <h2 className="truncate text-sm font-semibold text-slate-900">
                {editing.board ? "Edit whiteboard" : "New whiteboard"}
              </h2>
            </div>

            <button
              type="button"
              onClick={closeEditor}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-[12.5px] font-medium text-slate-700 hover:bg-slate-50"
            >
              <X size={14} /> Close
            </button>
          </div>

          <div className="min-h-0 flex-1 p-3">
            <WhiteboardEditor key={editing.key} lectureId={lectureId} initialBoard={editing.board} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
