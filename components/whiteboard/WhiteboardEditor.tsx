"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { FilePlus2, FolderOpen, Radio, Save, SaveAll, Trash2, X } from "lucide-react";

import type { ExcalidrawImperativeAPI } from "./WhiteboardCanvas";
import WhiteboardCanvasLazy from "./WhiteboardCanvasLazy";
import { EMPTY_SCENE, formatWhiteboardDate, sceneSignature } from "./scene-utils";
import type { WhiteboardDetail, WhiteboardListItem, WhiteboardScene } from "@/types/whiteboard";

type Props = {
  lectureId: string;
  /** Saved whiteboard to open first. Omit to start with an empty board. */
  initialBoard?: WhiteboardDetail | null;
  /** When set, every change is broadcast live to the students of this session. */
  sessionId?: string | null;
  /** Show the "Saved" picker (used inside the live classroom). */
  showSavedList?: boolean;
  /** The editor may sit in a hidden container; flips true when it becomes visible again. */
  active?: boolean;
  /** Called after a whiteboard was created, updated or opened. */
  onSaved?: (board: WhiteboardDetail) => void;
};

type TitleDialog = { mode: "create" | "saveAs"; value: string } | null;

const BROADCAST_DELAY_MS = 300;

const primaryButton =
  "inline-flex items-center gap-1.5 rounded-md bg-[#4D6C90] px-3 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-[#3B5776] disabled:cursor-not-allowed disabled:opacity-60";
const secondaryButton =
  "inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[12.5px] font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60";

async function readApiError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return payload?.error?.message ?? fallback;
}

export default function WhiteboardEditor({
  lectureId,
  initialBoard = null,
  sessionId = null,
  showSavedList = false,
  active = true,
  onSaved,
}: Props) {
  const [board, setBoard] = useState<{ id: string | null; title: string }>({
    id: initialBoard?.id ?? null,
    title: initialBoard?.title ?? "",
  });
  const [canvasKey, setCanvasKey] = useState(0);
  const [canvasScene, setCanvasScene] = useState<WhiteboardScene>(initialBoard?.data ?? EMPTY_SCENE);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [titleDialog, setTitleDialog] = useState<TitleDialog>(null);

  const [listOpen, setListOpen] = useState(false);
  const [list, setList] = useState<WhiteboardListItem[]>([]);
  const [listLoading, setListLoading] = useState(false);

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const sceneRef = useRef<WhiteboardScene>(initialBoard?.data ?? EMPTY_SCENE);
  const savedSignatureRef = useRef<string>(sceneSignature(initialBoard?.data ?? EMPTY_SCENE));

  /* ------------------------------ live broadcast ------------------------------ */

  const broadcastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const broadcastInFlightRef = useRef(false);
  const broadcastPendingRef = useRef(false);

  const flushBroadcast = useCallback(async () => {
    if (!sessionId) {
      return;
    }

    if (broadcastInFlightRef.current) {
      broadcastPendingRef.current = true;
      return;
    }

    broadcastInFlightRef.current = true;

    try {
      await fetch(`/api/sessions/${sessionId}/whiteboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene: sceneRef.current }),
      });
    } catch {
      // A missed frame is fine: the next change sends the whole scene again.
    } finally {
      broadcastInFlightRef.current = false;

      if (broadcastPendingRef.current) {
        broadcastPendingRef.current = false;
        void flushBroadcast();
      }
    }
  }, [sessionId]);

  const scheduleBroadcast = useCallback(() => {
    if (!sessionId || broadcastTimerRef.current) {
      return;
    }

    broadcastTimerRef.current = setTimeout(() => {
      broadcastTimerRef.current = null;
      void flushBroadcast();
    }, BROADCAST_DELAY_MS);
  }, [sessionId, flushBroadcast]);

  useEffect(() => {
    // Let students see the board as soon as the teacher opens it.
    void flushBroadcast();

    return () => {
      if (broadcastTimerRef.current) {
        clearTimeout(broadcastTimerRef.current);
        broadcastTimerRef.current = null;
      }
    };
  }, [flushBroadcast]);

  /* --------------------------------- canvas --------------------------------- */

  const handleSceneChange = useCallback(
    (scene: WhiteboardScene) => {
      sceneRef.current = scene;
      setDirty(sceneSignature(scene) !== savedSignatureRef.current);
      scheduleBroadcast();
    },
    [scheduleBroadcast]
  );

  useEffect(() => {
    if (active) {
      apiRef.current?.refresh();
    }
  }, [active]);

  const loadBoard = useCallback(
    (next: { id: string | null; title: string; scene: WhiteboardScene }) => {
      sceneRef.current = next.scene;
      savedSignatureRef.current = sceneSignature(next.scene);
      setBoard({ id: next.id, title: next.title });
      setCanvasScene(next.scene);
      setCanvasKey((key) => key + 1);
      setDirty(false);
      scheduleBroadcast();
    },
    [scheduleBroadcast]
  );

  function startNewBoard() {
    if (dirty && !window.confirm("Discard the unsaved changes on this whiteboard?")) {
      return;
    }

    setListOpen(false);
    loadBoard({ id: null, title: "", scene: EMPTY_SCENE });
  }

  function clearBoard() {
    if (!window.confirm("Clear the whiteboard? Saved whiteboards are not affected until you save.")) {
      return;
    }

    // resetScene triggers onChange, which broadcasts the empty board.
    apiRef.current?.resetScene();
  }

  /* --------------------------------- saving --------------------------------- */

  async function persist(mode: "create" | "update", title: string) {
    setSaving(true);

    try {
      const scene = sceneRef.current;
      const isUpdate = mode === "update" && board.id;

      const response = await fetch(
        isUpdate
          ? `/api/lectures/${lectureId}/whiteboards/${board.id}`
          : `/api/lectures/${lectureId}/whiteboards`,
        {
          method: isUpdate ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(isUpdate ? { data: scene } : { title, data: scene }),
        }
      );

      if (!response.ok) {
        throw new Error(await readApiError(response, "Could not save the whiteboard."));
      }

      const payload = (await response.json()) as { data: { whiteboard: WhiteboardDetail } };
      const saved = payload.data.whiteboard;

      savedSignatureRef.current = sceneSignature(scene);
      setBoard({ id: saved.id, title: saved.title });
      setDirty(false);
      setTitleDialog(null);
      toast.success(isUpdate ? "Whiteboard updated." : "Whiteboard saved.");
      onSaved?.(saved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the whiteboard.");
    } finally {
      setSaving(false);
    }
  }

  function handleSave() {
    if (board.id) {
      void persist("update", board.title);
      return;
    }

    setTitleDialog({ mode: "create", value: "" });
  }

  function handleSaveAsNew() {
    setTitleDialog({ mode: "saveAs", value: board.title ? `${board.title} (copy)` : "" });
  }

  function submitTitleDialog() {
    if (!titleDialog) {
      return;
    }

    const title = titleDialog.value.trim();

    if (title.length < 2) {
      toast.error("Whiteboard title must be at least 2 characters long.");
      return;
    }

    void persist("create", title);
  }

  /* ------------------------------- saved list ------------------------------- */

  async function toggleList() {
    const next = !listOpen;
    setListOpen(next);

    if (!next) {
      return;
    }

    setListLoading(true);

    try {
      const response = await fetch(`/api/lectures/${lectureId}/whiteboards`);

      if (!response.ok) {
        throw new Error(await readApiError(response, "Could not load saved whiteboards."));
      }

      const payload = (await response.json()) as { data: WhiteboardListItem[] };
      setList(payload.data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load saved whiteboards.");
    } finally {
      setListLoading(false);
    }
  }

  async function openSaved(item: WhiteboardListItem) {
    if (dirty && !window.confirm("Discard the unsaved changes on this whiteboard?")) {
      return;
    }

    try {
      const response = await fetch(`/api/lectures/${lectureId}/whiteboards/${item.id}`);

      if (!response.ok) {
        throw new Error(await readApiError(response, "Could not open the whiteboard."));
      }

      const payload = (await response.json()) as { data: { whiteboard: WhiteboardDetail } };
      const opened = payload.data.whiteboard;

      setListOpen(false);
      loadBoard({ id: opened.id, title: opened.title, scene: opened.data });
      onSaved?.(opened);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open the whiteboard.");
    }
  }

  /* ---------------------------------- view ---------------------------------- */

  return (
    <div className="relative flex h-full min-h-[320px] flex-col gap-2 text-slate-900">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto min-w-0">
          <p className="truncate text-[13px] font-semibold text-slate-900">
            {board.title || "Untitled whiteboard"}
          </p>
          <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
            {dirty ? "Unsaved changes" : board.id ? "Saved" : "Not saved yet"}
            {sessionId ? (
              <span className="inline-flex items-center gap-1 text-emerald-600">
                <Radio size={11} /> Live to students
              </span>
            ) : null}
          </p>
        </div>

        {showSavedList ? (
          <button type="button" onClick={() => void toggleList()} className={secondaryButton}>
            <FolderOpen size={14} />
            Saved
          </button>
        ) : null}

        <button type="button" onClick={startNewBoard} className={secondaryButton}>
          <FilePlus2 size={14} />
          New
        </button>

        <button type="button" onClick={clearBoard} className={secondaryButton}>
          <Trash2 size={14} />
          Clear
        </button>

        {board.id ? (
          <button type="button" onClick={handleSaveAsNew} disabled={saving} className={secondaryButton}>
            <SaveAll size={14} />
            Save as new
          </button>
        ) : null}

        <button type="button" onClick={handleSave} disabled={saving} className={primaryButton}>
          <Save size={14} />
          {saving ? "Saving..." : board.id ? "Save" : "Save Whiteboard"}
        </button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-200">
        <WhiteboardCanvasLazy
          key={canvasKey}
          initialScene={canvasScene}
          onReady={(api: ExcalidrawImperativeAPI) => {
            apiRef.current = api;
          }}
          onSceneChange={handleSceneChange}
        />

        {listOpen ? (
          <div className="absolute right-2 top-2 z-20 w-72 max-w-[calc(100%-1rem)] rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
            <div className="mb-1.5 flex items-center justify-between px-1">
              <p className="text-[12.5px] font-semibold text-slate-800">Saved whiteboards</p>
              <button
                type="button"
                onClick={() => setListOpen(false)}
                className="rounded p-1 text-slate-500 hover:bg-slate-100"
                aria-label="Close list"
              >
                <X size={14} />
              </button>
            </div>

            {listLoading ? (
              <p className="px-1 py-3 text-[12px] text-slate-500">Loading...</p>
            ) : list.length === 0 ? (
              <p className="px-1 py-3 text-[12px] text-slate-500">No saved whiteboards for this lecture yet.</p>
            ) : (
              <ul className="max-h-60 space-y-1 overflow-y-auto">
                {list.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => void openSaved(item)}
                      className={`w-full rounded-md border px-2.5 py-1.5 text-left transition hover:bg-slate-50 ${
                        item.id === board.id ? "border-[#4D6C90]" : "border-slate-200"
                      }`}
                    >
                      <span className="block truncate text-[12.5px] font-medium text-slate-900">{item.title}</span>
                      <span className="block text-[11px] text-slate-500">
                        {formatWhiteboardDate(item.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      {titleDialog ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center rounded-lg bg-black/40 p-4">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitTitleDialog();
            }}
            className="w-full max-w-sm rounded-xl bg-white p-4 shadow-2xl"
          >
            <h3 className="text-[14px] font-semibold text-slate-900">
              {titleDialog.mode === "saveAs" ? "Save as a new whiteboard" : "Save whiteboard"}
            </h3>

            <label className="mt-3 block text-[12.5px] font-semibold text-slate-700" htmlFor="whiteboard-title">
              Whiteboard title
            </label>
            <input
              id="whiteboard-title"
              autoFocus
              value={titleDialog.value}
              maxLength={150}
              onChange={(event) => setTitleDialog({ ...titleDialog, value: event.target.value })}
              placeholder="Quadratic Equations"
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-[#4D6C90]"
            />

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setTitleDialog(null)} className={secondaryButton}>
                Cancel
              </button>
              <button type="submit" disabled={saving} className={primaryButton}>
                <Save size={14} />
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
