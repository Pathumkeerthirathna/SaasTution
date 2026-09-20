"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, Radio, X } from "lucide-react";

import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import type { ExcalidrawImperativeAPI } from "./WhiteboardCanvas";
import WhiteboardCanvasLazy from "./WhiteboardCanvasLazy";
import SavedWhiteboardViewer from "./SavedWhiteboardViewer";
import { formatWhiteboardDate } from "./scene-utils";
import type { WhiteboardListItem, WhiteboardLiveUpdate, WhiteboardScene } from "@/types/whiteboard";

type Props = {
  sessionId: string;
  lectureId: string;
  /** The panel may sit in a hidden container; flips true when it becomes visible again. */
  active?: boolean;
};

/** Student view inside the classroom: the teacher's live board (read-only) plus saved boards. */
export default function LiveWhiteboardViewer({ sessionId, lectureId, active = true }: Props) {
  const [hasScene, setHasScene] = useState(false);
  const [connected, setConnected] = useState(false);

  const [listOpen, setListOpen] = useState(false);
  const [list, setList] = useState<WhiteboardListItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [viewing, setViewing] = useState<WhiteboardListItem | null>(null);

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const pendingSceneRef = useRef<WhiteboardScene | null>(null);
  const fittedRef = useRef(false);

  const applyScene = useCallback((scene: WhiteboardScene) => {
    const api = apiRef.current;

    if (!api) {
      pendingSceneRef.current = scene;
      return;
    }

    // Stored elements came from Excalidraw itself, so they can be applied as they are.
    const elements = scene.elements as unknown as readonly ExcalidrawElement[];

    api.updateScene({
      elements,
      appState: { viewBackgroundColor: scene.viewBackgroundColor ?? "#ffffff" },
    });

    if (!fittedRef.current && scene.elements.length > 0) {
      fittedRef.current = true;
      api.scrollToContent(elements, { fitToViewport: true, viewportZoomFactor: 0.9 });
    }
  }, []);

  useEffect(() => {
    const source = new EventSource(`/api/sessions/${sessionId}/whiteboard?role=student`);

    source.addEventListener("connected", () => setConnected(true));

    source.addEventListener("scene", (event) => {
      try {
        const update = JSON.parse((event as MessageEvent<string>).data) as WhiteboardLiveUpdate;
        setHasScene(true);
        applyScene(update.scene);
      } catch {
        /* ignore a malformed frame */
      }
    });

    source.onerror = () => setConnected(false);

    return () => {
      source.close();
    };
  }, [sessionId, applyScene]);

  useEffect(() => {
    if (active) {
      apiRef.current?.refresh();
    }
  }, [active]);

  async function toggleList() {
    const next = !listOpen;
    setListOpen(next);

    if (!next) {
      return;
    }

    setListLoading(true);

    try {
      const response = await fetch(`/api/student/lectures/${lectureId}/whiteboards`);
      const payload = (await response.json().catch(() => null)) as { data?: WhiteboardListItem[] } | null;
      setList(response.ok && payload?.data ? payload.data : []);
    } finally {
      setListLoading(false);
    }
  }

  return (
    <div className="relative flex h-full min-h-[320px] flex-col gap-2 text-slate-900">
      <div className="flex items-center gap-2">
        <div className="mr-auto min-w-0">
          <p className="text-[13px] font-semibold text-slate-900">Teacher&apos;s whiteboard</p>
          <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <Radio size={11} className={connected ? "text-emerald-600" : "text-slate-400"} />
            {connected ? "Live · view only" : "Connecting..."}
          </p>
        </div>

        <button
          type="button"
          onClick={() => void toggleList()}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[12.5px] font-medium text-slate-700 transition hover:bg-slate-50"
        >
          <FolderOpen size={14} />
          Saved
        </button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-200">
        <WhiteboardCanvasLazy
          readOnly
          onReady={(api: ExcalidrawImperativeAPI) => {
            apiRef.current = api;

            if (pendingSceneRef.current) {
              const pending = pendingSceneRef.current;
              pendingSceneRef.current = null;
              applyScene(pending);
            }
          }}
        />

        {!hasScene ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-white/70 p-4 text-center text-[13px] text-slate-600">
            Waiting for the teacher to open the whiteboard...
          </div>
        ) : null}

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
                      onClick={() => setViewing(item)}
                      className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-left transition hover:bg-slate-50"
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

      {viewing ? (
        <SavedWhiteboardViewer
          lectureId={lectureId}
          whiteboardId={viewing.id}
          title={viewing.title}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </div>
  );
}
