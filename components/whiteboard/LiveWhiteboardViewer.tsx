"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, Maximize, Minus, Plus, Radio, X } from "lucide-react";

import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

import type { ExcalidrawImperativeAPI } from "./WhiteboardCanvas";
import WhiteboardCanvasLazy from "./WhiteboardCanvasLazy";
import SavedWhiteboardViewer from "./SavedWhiteboardViewer";
import { formatWhiteboardDate } from "./scene-utils";
import type { WhiteboardListItem, WhiteboardLiveUpdate, WhiteboardScene } from "@/types/whiteboard";

/* ------------------------------ student zoom ------------------------------ */
// Excalidraw 0.18.1 hides its own zoom buttons in its mobile layout. These
// mirror its rules so the student's own controls show exactly then.

/** Excalidraw's zoom step and limits (ZOOM_STEP, MIN_ZOOM, MAX_ZOOM). */
export const ZOOM_STEP = 0.1;
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 30;

/** The one-time fit when the first drawing arrives, and the Fit button: never above 100%. */
export const FIT_OPTIONS = { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1 } as const;

/** Excalidraw's isMobileBreakpoint for its container: no built-in zoom buttons. */
export function isExcalidrawMobileLayout(width: number, height: number): boolean {
  return width < 730 || (height < 500 && width < 1000);
}

/** Excalidraw's getNormalizedZoom: rounded to 6 decimals, within the limits. */
export function normalizeZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 1e6) / 1e6));
}

type ZoomView = { zoom: number; scrollX: number; scrollY: number; width: number; height: number };

/** A new zoom around the canvas centre (Excalidraw's getStateForZoom), so the centre stays put. */
export function zoomAroundCenter(view: ZoomView, nextZoom: number) {
  const zoom = normalizeZoom(nextZoom);
  const centerX = view.width / 2;
  const centerY = view.height / 2;

  return {
    zoom,
    scrollX: view.scrollX + centerX / zoom - centerX / view.zoom,
    scrollY: view.scrollY + centerY / zoom - centerY / view.zoom,
  };
}

type StudentZoomControlsProps = {
  zoom: number;
  canFit: boolean;
  onZoomOut: () => void;
  onReset: () => void;
  onZoomIn: () => void;
  onFit: () => void;
};

const zoomButton =
  "inline-flex h-9 min-w-9 items-center justify-center rounded-md px-2 text-slate-700 transition hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40";

/** The student's own zoom controls, shown while Excalidraw hides its own. */
export function StudentZoomControls({ zoom, canFit, onZoomOut, onReset, onZoomIn, onFit }: StudentZoomControlsProps) {
  const percent = Math.round(zoom * 100);

  return (
    <div
      role="group"
      aria-label="Whiteboard zoom"
      className="absolute left-2 top-2 z-[15] flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white/95 p-0.5 shadow-sm"
    >
      <button type="button" onClick={onZoomOut} disabled={zoom <= MIN_ZOOM} aria-label="Zoom out" title="Zoom out" className={zoomButton}>
        <Minus size={16} />
      </button>
      <button
        type="button"
        onClick={onReset}
        aria-label={`Reset zoom to 100% (now ${percent}%)`}
        title="Reset zoom"
        className={`${zoomButton} w-14 text-[12px] font-medium tabular-nums`}
      >
        {percent}%
      </button>
      <button type="button" onClick={onZoomIn} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in" title="Zoom in" className={zoomButton}>
        <Plus size={16} />
      </button>
      <button type="button" onClick={onFit} disabled={!canFit} aria-label="Fit drawing to screen" title="Fit to screen" className={zoomButton}>
        <Maximize size={15} />
      </button>
    </div>
  );
}

type LoadingApi = Pick<ExcalidrawImperativeAPI, "getAppState">;

/** How often readiness is checked while Excalidraw initializes. */
export const READY_POLL_MS = 50;

/**
 * Calls `ready` once Excalidraw has finished initializing. The API is handed
 * out while it is still loading, and its initialization then replaces the
 * scene with initialData (empty here), so a scene applied earlier is lost.
 *
 * Polls `isLoading` rather than waiting for onChange: in React Strict Mode
 * (development) Excalidraw is mounted, unmounted and mounted again, and its
 * componentWillUnmount clears every onChange listener, so a listener added
 * when the API was handed out would never fire. Returns a cancel.
 */
export function whenExcalidrawReady(api: LoadingApi, ready: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const check = () => {
    if (cancelled) {
      return;
    }

    if (api.getAppState()?.isLoading === false) {
      cancelled = true;
      ready();
      return;
    }

    timer = setTimeout(check, READY_POLL_MS);
  };

  check();

  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

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

  // Zoom is this student's own view: it lives only in their Excalidraw state.
  const canvasBoxRef = useRef<HTMLDivElement | null>(null);
  const unsubscribeZoomRef = useRef<(() => void) | null>(null);
  const cancelReadyRef = useRef<(() => void) | null>(null);
  const [apiReady, setApiReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [builtInZoomHidden, setBuiltInZoomHidden] = useState(false);

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

    // Only the first drawing is fitted (never zoomed in past 100%); later
    // scenes keep the student's own zoom and scroll.
    if (!fittedRef.current && scene.elements.length > 0) {
      fittedRef.current = true;
      api.scrollToContent(elements, FIT_OPTIONS);
    }
  }, []);

  // Excalidraw's container is this box's content box: the same size its mobile layout checks.
  useEffect(() => {
    const box = canvasBoxRef.current;

    if (!box || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setBuiltInZoomHidden(isExcalidrawMobileLayout(entry.contentRect.width, entry.contentRect.height));
    });

    observer.observe(box);

    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      unsubscribeZoomRef.current?.();
      cancelReadyRef.current?.();
    },
    []
  );

  // Reads the live zoom from Excalidraw (not React state), so quick taps never use a stale value.
  const setViewZoom = useCallback((nextZoom: (current: number) => number) => {
    const api = apiRef.current;

    if (!api) {
      return;
    }

    const state = api.getAppState();
    const next = zoomAroundCenter(
      { zoom: state.zoom.value, scrollX: state.scrollX, scrollY: state.scrollY, width: state.width, height: state.height },
      nextZoom(state.zoom.value)
    );

    api.updateScene({
      appState: { zoom: { value: next.zoom as AppState["zoom"]["value"] }, scrollX: next.scrollX, scrollY: next.scrollY },
    });
  }, []);

  const fitDrawing = useCallback(() => {
    const api = apiRef.current;

    if (api && api.getSceneElements().length > 0) {
      api.scrollToContent(api.getSceneElements(), FIT_OPTIONS);
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

      <div ref={canvasBoxRef} className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-200">
        <WhiteboardCanvasLazy
          readOnly
          onReady={(api: ExcalidrawImperativeAPI) => {
            unsubscribeZoomRef.current?.();
            unsubscribeZoomRef.current = api.onScrollChange((_scrollX, _scrollY, nextZoom) => {
              setZoom(nextZoom.value);
            });

            // Until Excalidraw has initialized, scenes stay pending (newest
            // wins): one applied earlier would be replaced by its empty start.
            // A newer API (Strict Mode constructs twice) cancels the older wait.
            cancelReadyRef.current?.();
            cancelReadyRef.current = whenExcalidrawReady(api, () => {
              cancelReadyRef.current = null;
              apiRef.current = api;
              setApiReady(true);

              if (pendingSceneRef.current) {
                const pending = pendingSceneRef.current;
                pendingSceneRef.current = null;
                applyScene(pending);
              }
            });
          }}
        />

        {!hasScene ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-white/70 p-4 text-center text-[13px] text-slate-600">
            Waiting for the teacher to open the whiteboard...
          </div>
        ) : null}

        {apiReady && hasScene && builtInZoomHidden ? (
          <StudentZoomControls
            zoom={zoom}
            canFit={hasScene}
            onZoomOut={() => setViewZoom((current) => current - ZOOM_STEP)}
            onReset={() => setViewZoom(() => 1)}
            onZoomIn={() => setViewZoom((current) => current + ZOOM_STEP)}
            onFit={fitDrawing}
          />
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
