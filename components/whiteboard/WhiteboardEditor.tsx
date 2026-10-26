"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { FilePlus2, FolderOpen, Radio, Save, SaveAll, Trash2, X } from "lucide-react";

import type { ExcalidrawImperativeAPI } from "./WhiteboardCanvas";
import WhiteboardCanvasLazy from "./WhiteboardCanvasLazy";
import { EMPTY_SCENE, formatWhiteboardDate, sceneSignature } from "./scene-utils";
import type { WhiteboardDetail, WhiteboardListItem, WhiteboardLiveUpdate, WhiteboardScene } from "@/types/whiteboard";

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

export type LiveSceneSource = Pick<EventSource, "addEventListener" | "close">;

/**
 * How long the read of the live scene waits: the server sends the latest
 * scene right after "connected" (settle: more frames of the same burst),
 * so none within the grace means there is no live board.
 */
export const LIVE_RESTORE_TIMING = { settleMs: 150, graceMs: 1000, timeoutMs: 8000 };

/**
 * Reads the session's latest live scene once from the teacher stream, then
 * closes it: `done(scene)`, or `done(null)` when there is none (or the stream
 * never answered). The newest scene received wins. Returns a cancel.
 */
export function readLatestLiveScene(
  source: LiveSceneSource,
  done: (scene: WhiteboardScene | null) => void,
  timing = LIVE_RESTORE_TIMING
): () => void {
  let latest: WhiteboardScene | null = null;
  let finished = false;
  let timer: ReturnType<typeof setTimeout>;

  const stop = () => {
    finished = true;
    clearTimeout(timer);
    source.close();
  };

  const finish = () => {
    if (!finished) {
      stop();
      done(latest);
    }
  };

  const finishIn = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(finish, ms);
  };

  timer = setTimeout(finish, timing.timeoutMs);

  source.addEventListener("connected", () => {
    if (!finished && !latest) {
      finishIn(timing.graceMs);
    }
  });

  source.addEventListener("scene", (event) => {
    if (finished) {
      return;
    }

    try {
      latest = (JSON.parse((event as MessageEvent<string>).data) as WhiteboardLiveUpdate).scene;
    } catch {
      /* ignore a malformed frame */
    }

    finishIn(timing.settleMs);
  });

  return () => {
    if (!finished) {
      stop();
    }
  };
}

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

  // Until the live scene is read (a refresh / rejoin may find students
  // already watching a board), nothing is broadcast.
  const restorePendingRef = useRef(Boolean(sessionId));
  // The teacher changed the board since the editor opened: their scene wins.
  const localChangeRef = useRef(false);
  // The canvas reports the scene it was loaded with (the empty start, a
  // restored live board): that echo is not a change and is never broadcast.
  const loadedSignatureRef = useRef<string | null>(sceneSignature(initialBoard?.data ?? EMPTY_SCENE));

  const flushBroadcast = useCallback(async () => {
    if (!sessionId || restorePendingRef.current) {
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
    return () => {
      if (broadcastTimerRef.current) {
        clearTimeout(broadcastTimerRef.current);
        broadcastTimerRef.current = null;
      }
    };
  }, [flushBroadcast]);

  // Shows the live board students are already watching, without broadcasting
  // it again (the server has it) and without marking it as a saved board.
  const restoreLiveScene = useCallback((scene: WhiteboardScene) => {
    sceneRef.current = scene;
    loadedSignatureRef.current = sceneSignature(scene);
    setCanvasScene(scene);
    setCanvasKey((key) => key + 1);
    setDirty(sceneSignature(scene) !== savedSignatureRef.current);
  }, []);

  useEffect(() => {
    if (!sessionId) {
      restorePendingRef.current = false;
      return;
    }

    restorePendingRef.current = true;

    const source = new EventSource(`/api/sessions/${sessionId}/whiteboard?role=teacher`);

    return readLatestLiveScene(source, (live) => {
      restorePendingRef.current = false;

      if (localChangeRef.current) {
        // Changed while the read was pending: the teacher's newer scene wins.
        void flushBroadcast();
      } else if (live && live.elements.length > 0) {
        restoreLiveScene(live);
      } else if (sceneRef.current.elements.length > 0) {
        // No live board: a non-empty starting board is shown to students.
        void flushBroadcast();
      }
      // Otherwise nothing is sent: an empty start never replaces a live board.
    });
  }, [sessionId, flushBroadcast, restoreLiveScene]);

  /* --------------------------------- canvas --------------------------------- */

  const handleSceneChange = useCallback(
    (scene: WhiteboardScene) => {
      sceneRef.current = scene;
      setDirty(sceneSignature(scene) !== savedSignatureRef.current);

      const signature = sceneSignature(scene);

      if (loadedSignatureRef.current !== null) {
        if (signature === loadedSignatureRef.current) {
          return;
        }

        loadedSignatureRef.current = null;
      }

      localChangeRef.current = true;
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
      // An explicit choice (new board, open a saved one): always broadcast.
      loadedSignatureRef.current = null;
      localChangeRef.current = true;
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

    // resetScene triggers onChange, which broadcasts the empty board (an
    // intentional clear, so it is never treated as the empty start).
    loadedSignatureRef.current = null;
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
