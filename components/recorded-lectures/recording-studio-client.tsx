"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Circle, Loader2, Pause, Play, RotateCcw, Save, Square, Trash2, Video } from "lucide-react";

import { openRecordingStore, type LocalRecording, type RecordingStore } from "./recording-store";
import { StudioController, type RecorderLike, type StreamLike, type StudioState, type TrackLike } from "./studio-controller";
import {
  formatClock,
  STUDIO_MODES,
  studioFileName,
  studioSupport,
  suggestedRecordingTitle,
  SUPPORTED_BROWSERS_TEXT,
  type StudioMode,
  type StudioSupport,
} from "./studio-helpers";
import { uploadLocalRecording } from "./studio-upload";
import { formatBytes, progressPercent, type RecordingUploader, type UploadSnapshot } from "./upload-engine";

/*
 * Recording Studio (teacher): record camera / screen with the microphone
 * using the browser's MediaRecorder (MP4, H.264 + AAC only), review the
 * finished recording, then save it as a new part through the normal upload.
 * Nothing is uploaded before the teacher confirms the preview.
 *
 * Camera + screen together (picture-in-picture composition) is NOT offered:
 * drawing both onto a canvas is throttled by browsers when the tab is in the
 * background (exactly when the teacher is presenting another window), so it
 * is not reliable enough without real-browser verification.
 */

export type StudioPageProps = {
  teacherId: string;
  lecture: { id: string; title: string; className: string };
  nextPartNumber: number;
  maxMoovBytes: number;
};

type Device = { deviceId: string; label: string };

function browserSupport(): StudioSupport {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const MR = typeof MediaRecorder === "undefined" ? undefined : MediaRecorder;
  return studioSupport({
    isSecureContext: typeof window === "undefined" ? undefined : window.isSecureContext,
    hasGetUserMedia: Boolean(nav?.mediaDevices?.getUserMedia),
    hasGetDisplayMedia: Boolean(nav?.mediaDevices && "getDisplayMedia" in nav.mediaDevices),
    hasMediaRecorder: Boolean(MR),
    isTypeSupported: MR ? (type: string) => MR.isTypeSupported(type) : null,
    hasAudioContext: typeof window !== "undefined" && typeof window.AudioContext === "function",
  });
}

function silentAudioTrack(): { track: TrackLike; close(): void } | null {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = 0;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    const track = destination.stream.getAudioTracks()[0];
    if (!track) return null;
    return {
      track: track as unknown as TrackLike,
      close: () => {
        oscillator.stop();
        void context.close();
      },
    };
  } catch {
    return null;
  }
}

export function RecordingStudioClient({ teacherId, lecture, nextPartNumber, maxMoovBytes }: StudioPageProps) {
  const [support, setSupport] = useState<StudioSupport | null>(null);
  const [store, setStore] = useState<(RecordingStore & { persistent: boolean }) | null>(null);
  const [state, setState] = useState<StudioState>({ kind: "idle" });
  const [mode, setMode] = useState<StudioMode>("camera-mic");
  const [cameras, setCameras] = useState<Device[]>([]);
  const [microphones, setMicrophones] = useState<Device[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [microphoneId, setMicrophoneId] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [pending, setPending] = useState<LocalRecording[]>([]);
  const [title, setTitle] = useState(suggestedRecordingTitle(lecture.title, nextPartNumber));
  const [partNumber, setPartNumber] = useState(String(nextPartNumber));
  const [upload, setUpload] = useState<UploadSnapshot | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const controllerRef = useRef<StudioController | null>(null);
  const uploaderRef = useRef<RecordingUploader | null>(null);
  const liveRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    setSupport(browserSupport());
    void openRecordingStore().then(setStore);
  }, []);

  const listPending = useCallback(async () => {
    if (!store) return;
    setPending(await store.listRecordings(teacherId, lecture.id));
  }, [store, teacherId, lecture.id]);

  useEffect(() => {
    void listPending();
  }, [listPending]);

  // The controller, once the store and the format are known.
  useEffect(() => {
    if (!store || !support?.mimeType) return;
    const controller = new StudioController({
      teacherId,
      lectureId: lecture.id,
      mimeType: support.mimeType,
      store,
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints as MediaStreamConstraints) as Promise<unknown> as Promise<StreamLike>,
      getDisplayMedia: navigator.mediaDevices?.getDisplayMedia
        ? (constraints) => navigator.mediaDevices.getDisplayMedia(constraints as DisplayMediaStreamOptions) as Promise<unknown> as Promise<StreamLike>
        : undefined,
      createSilentAudioTrack: silentAudioTrack,
      combine: (tracks) => new MediaStream(tracks as unknown as MediaStreamTrack[]) as unknown as StreamLike,
      createRecorder: (stream, mimeType) =>
        new MediaRecorder(stream as unknown as MediaStream, { mimeType, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 }) as unknown as RecorderLike,
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
      maxMoovBytes,
      onChange: (next) => setState(next),
    });
    controllerRef.current = controller;
    return () => {
      controller.releaseSources();
      controllerRef.current = null;
    };
  }, [store, support?.mimeType, teacherId, lecture.id, maxMoovBytes]);

  // Live preview of what is being recorded.
  useEffect(() => {
    const video = liveRef.current;
    const live = controllerRef.current?.liveStream ?? null;
    if (video) video.srcObject = (live as unknown as MediaStream) ?? null;
  }, [state.kind]);

  // Timer.
  useEffect(() => {
    if (state.kind !== "recording" && state.kind !== "paused") return;
    const timer = setInterval(() => setElapsed(controllerRef.current?.elapsedMs() ?? 0), 500);
    return () => clearInterval(timer);
  }, [state.kind]);

  // Warn before leaving while recording or uploading.
  const busy = state.kind === "recording" || state.kind === "paused" || state.kind === "stopping" || (upload !== null && ["starting", "uploading", "retrying", "completing"].includes(upload.phase));
  useEffect(() => {
    if (!busy) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [busy]);

  // Preview URL for the reviewed recording.
  const reviewUrl = useMemo(() => (state.kind === "review" ? URL.createObjectURL(state.blob) : null), [state]);
  useEffect(() => () => {
    if (reviewUrl) URL.revokeObjectURL(reviewUrl);
  }, [reviewUrl]);

  async function loadDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setCameras(devices.filter((d) => d.kind === "videoinput").map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` })));
      setMicrophones(devices.filter((d) => d.kind === "audioinput").map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` })));
    } catch {
      // Device names are a convenience; the default devices still work.
    }
  }

  async function prepare() {
    setSaveError(null);
    setUpload(null);
    await controllerRef.current?.prepare({ mode, cameraId: cameraId || null, microphoneId: microphoneId || null });
    await loadDevices(); // labels are only available after permission
  }

  async function start() {
    try {
      await navigator.storage?.persist?.();
    } catch {
      // Best effort: the browser decides.
    }
    setElapsed(0);
    await controllerRef.current?.start();
  }

  async function save() {
    if (state.kind !== "review" || !store) return;
    setSaveError(null);
    const part = Number(partNumber);
    if (!title.trim()) return setSaveError("Enter a title for this part.");
    if (!Number.isInteger(part) || part < 1) return setSaveError("The part number must be a whole number of at least 1.");
    const local = await store.getRecording(state.recordingId);
    if (!local) return setSaveError("The recording is no longer stored in this browser.");
    const result = await uploadLocalRecording({
      store,
      local,
      blob: state.blob,
      title: title.trim(),
      partNumber: part,
      fileName: studioFileName(lecture.title, local.startedAt),
      deps: { fetch: (input, init) => fetch(input, init), onUpdate: setUpload },
      onUploader: (uploader) => {
        uploaderRef.current = uploader;
      },
    });
    setUpload(result);
    await listPending();
  }

  async function discard(recordingId: string) {
    await store?.deleteRecording(recordingId);
    if (state.kind === "review" && state.recordingId === recordingId) await controllerRef.current?.retake();
    await listPending();
  }

  const uploading = upload !== null && !["ready", "cancelled", "failed", "expired", "error", "paused"].includes(upload.phase);
  const recoverable = pending.filter((p) => !(state.kind === "review" && state.recordingId === p.id));

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <Link href={`/dashboard/lectures/${encodeURIComponent(lecture.id)}/recordings`} className="inline-flex min-h-[40px] items-center gap-1 text-xs font-semibold text-brand-700 hover:underline">
          <ArrowLeft size={14} aria-hidden />
          Recorded lectures
        </Link>
        <h1 className="break-words text-lg font-bold text-slate-900">Recording Studio — {lecture.title}</h1>
        <p className="text-xs text-slate-600">{lecture.className}</p>
      </div>

      {support && !support.supported ? (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">Recording is not available in this browser.</p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {support.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs">{SUPPORTED_BROWSERS_TEXT}</p>
        </div>
      ) : null}

      {store && !store.persistent ? (
        <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          This browser does not allow saving recordings on this device (private window or blocked site data). A recording is lost if this page is
          closed before it is uploaded.
        </p>
      ) : null}

      {recoverable.length > 0 && state.kind !== "recording" && state.kind !== "paused" ? (
        <section className="rounded-xl border border-sky-200 bg-sky-50 p-3">
          <p className="text-sm font-semibold text-sky-900">Unfinished recordings saved in this browser</p>
          <ul className="mt-2 space-y-2">
            {recoverable.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-sky-900">
                <span>
                  Recorded {new Date(p.startedAt).toLocaleString("en-GB", { timeZone: "Asia/Colombo" })}
                  {p.status === "recording" ? " (interrupted)" : p.status === "uploading" ? " (upload not finished)" : ""}
                </span>
                <span className="flex gap-2">
                  <button type="button" onClick={() => void controllerRef.current?.review(p.id, p.status === "recording")} className="inline-flex min-h-[40px] items-center gap-1 rounded-lg border border-sky-400 px-3 font-semibold">
                    <Play size={14} aria-hidden /> Review and save
                  </button>
                  <button type="button" onClick={() => void discard(p.id)} className="inline-flex min-h-[40px] items-center gap-1 rounded-lg border border-rose-300 px-3 font-semibold text-rose-700">
                    <Trash2 size={14} aria-hidden /> Discard
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {support?.supported ? (
        <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          {state.kind === "idle" || state.kind === "error" || state.kind === "ready" || state.kind === "requesting" ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold text-slate-700">What to record</legend>
                {STUDIO_MODES.map((m) => (
                  <label key={m.mode} className={`flex min-h-[44px] cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 ${mode === m.mode ? "border-brand-700 bg-brand-50" : "border-slate-200"} ${support.modes[m.mode] ? "" : "opacity-50"}`}>
                    <input type="radio" name="studio-mode" value={m.mode} checked={mode === m.mode} disabled={!support.modes[m.mode]} onChange={() => setMode(m.mode)} className="mt-1" />
                    <span>
                      <span className="block text-sm font-semibold text-slate-900">{m.label}</span>
                      <span className="block text-xs text-slate-600">{support.modes[m.mode] ? m.help : "Not available in this browser."}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <div className="space-y-2">
                {mode !== "screen-mic" ? (
                  <label className="block text-xs font-semibold text-slate-700">
                    Camera
                    <select value={cameraId} onChange={(event) => setCameraId(event.target.value)} className="mt-1 block min-h-[40px] w-full rounded-lg border border-slate-300 px-2 text-sm">
                      <option value="">Default camera</option>
                      {cameras.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {mode !== "camera-only" ? (
                  <label className="block text-xs font-semibold text-slate-700">
                    Microphone
                    <select value={microphoneId} onChange={(event) => setMicrophoneId(event.target.value)} className="mt-1 block min-h-[40px] w-full rounded-lg border border-slate-300 px-2 text-sm">
                      <option value="">Default microphone</option>
                      {microphones.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <button
                  type="button"
                  disabled={state.kind === "requesting" || !support.modes[mode]}
                  onClick={() => void prepare()}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-brand-700 px-4 text-sm font-semibold text-brand-700 disabled:opacity-60"
                >
                  {state.kind === "requesting" ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Video size={16} aria-hidden />}
                  {state.kind === "ready" ? "Use these devices again" : mode === "screen-mic" ? "Choose screen and allow microphone" : "Allow camera and microphone"}
                </button>
              </div>
            </div>
          ) : null}

          {state.kind === "error" ? (
            <p role="alert" className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
              {state.failure.message}
            </p>
          ) : null}

          {state.kind === "ready" || state.kind === "recording" || state.kind === "paused" || state.kind === "stopping" ? (
            <div className="space-y-3">
              <video ref={liveRef} autoPlay muted playsInline className="aspect-video w-full rounded-xl bg-black" aria-label="Live preview (muted)" />
              <div className="flex flex-wrap items-center gap-3">
                {state.kind === "ready" ? (
                  <button type="button" onClick={() => void start()} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-rose-600 px-4 text-sm font-semibold text-white">
                    <Circle size={14} className="fill-current" aria-hidden /> Start recording
                  </button>
                ) : null}
                {state.kind === "recording" ? (
                  <button type="button" onClick={() => controllerRef.current?.pause()} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold">
                    <Pause size={16} aria-hidden /> Pause
                  </button>
                ) : null}
                {state.kind === "paused" ? (
                  <button type="button" onClick={() => controllerRef.current?.resume()} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold">
                    <Play size={16} aria-hidden /> Resume
                  </button>
                ) : null}
                {state.kind === "recording" || state.kind === "paused" ? (
                  <button type="button" onClick={() => void controllerRef.current?.stop()} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white">
                    <Square size={14} className="fill-current" aria-hidden /> Stop
                  </button>
                ) : null}
                {state.kind === "stopping" ? (
                  <span className="inline-flex items-center gap-2 text-sm text-slate-700">
                    <Loader2 size={16} className="animate-spin" aria-hidden /> Saving the recording…
                  </span>
                ) : null}
                {state.kind === "recording" || state.kind === "paused" ? (
                  <span className={`inline-flex items-center gap-2 font-mono text-lg ${state.kind === "recording" ? "text-rose-600" : "text-slate-500"}`} role="timer" aria-live="off">
                    <Circle size={10} className={state.kind === "recording" ? "animate-pulse fill-current" : ""} aria-hidden />
                    {formatClock(elapsed)}
                    {state.kind === "paused" ? " (paused)" : ""}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          {state.kind === "review" ? (
            <div className="space-y-3">
              {state.notice ? (
                <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  {state.notice}
                </p>
              ) : null}
              {reviewUrl ? <video src={reviewUrl} controls playsInline className="aspect-video w-full rounded-xl bg-black" aria-label="Recording preview" /> : null}
              <p className="text-xs text-slate-600">
                {formatBytes(state.blob.size)}
                {state.check.ok ? ` · ${formatClock(state.check.durationSeconds * 1000)}` : ""}
              </p>
              {!state.check.ok ? (
                <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
                  {state.check.message}
                </p>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px]">
                <label className="block text-xs font-semibold text-slate-700">
                  Title
                  <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} className="mt-1 block min-h-[40px] w-full rounded-lg border border-slate-300 px-3 text-sm" />
                </label>
                <label className="block text-xs font-semibold text-slate-700">
                  Part number
                  <input value={partNumber} inputMode="numeric" onChange={(event) => setPartNumber(event.target.value.replace(/[^0-9]/g, ""))} className="mt-1 block min-h-[40px] w-full rounded-lg border border-slate-300 px-3 text-sm" />
                </label>
              </div>
              {upload ? (
                <div className="space-y-1">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent(upload.receivedBytes, upload.expectedBytes)} aria-label="Upload progress">
                    <div className="h-full bg-brand-700" style={{ width: `${progressPercent(upload.receivedBytes, upload.expectedBytes)}%` }} />
                  </div>
                  <p className="text-xs text-slate-600">
                    {upload.phase === "ready"
                      ? "Saved. Students can watch it now."
                      : upload.phase === "verifying" || upload.phase === "completing"
                        ? "Uploaded — checking the video…"
                        : `${progressPercent(upload.receivedBytes, upload.expectedBytes)}% uploaded`}
                  </p>
                  {upload.message ? (
                    <p role="alert" className="text-xs text-rose-700">
                      {upload.message}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {saveError ? (
                <p role="alert" className="text-sm text-rose-700">
                  {saveError}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {upload?.phase === "ready" ? (
                  <Link href={`/dashboard/lectures/${encodeURIComponent(lecture.id)}/recordings`} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-brand-700 px-4 text-sm font-semibold text-white">
                    Back to recorded lectures
                  </Link>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={!state.check.ok || uploading}
                      onClick={() => void save()}
                      className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-brand-700 px-4 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      {uploading ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Save size={16} aria-hidden />}
                      {upload && ["paused", "error", "expired", "failed"].includes(upload.phase) ? "Try saving again" : "Save as new part"}
                    </button>
                    {uploading ? (
                      <button type="button" onClick={() => uploaderRef.current?.pause()} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold">
                        <Pause size={16} aria-hidden /> Pause upload
                      </button>
                    ) : null}
                    {!uploading ? (
                      <button type="button" onClick={() => void controllerRef.current?.retake().then(listPending)} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold">
                        <RotateCcw size={16} aria-hidden /> Retake
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
