"use client";

/*
 * The teacher's physical QR scanner page (Stage 5.7b-3d),
 * /dashboard/attendance/[lectureId]/scan. Loads the register (GET
 * /api/lectures/[id]/attendance) and offers scanning only while its `qr`
 * window is OPEN for an eligible lecture (qr-scanner-logic.ts
 * scannerAvailability). The scan API stays the authority on every request.
 *
 * Input: the device camera (qr-camera.ts + jsqr, loaded on the first Start
 * camera), or the manual field, which also takes USB / Bluetooth scanners
 * that type the code and press Enter. Scans go through ONE sequential queue
 * (createScanQueue). Results are listed in memory only, newest first, and
 * announced to screen readers. The register is reloaded after scanning
 * activity (debounced), immediately when an answer says the QR state
 * changed, and on leaving (the register page loads it fresh). Leaving
 * stops the camera and drops every scan, payload and result from memory.
 * Nothing is stored in the browser and nothing is logged.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Camera,
  CameraOff,
  CheckCircle2,
  CircleHelp,
  Clock,
  Info,
  Keyboard,
  Loader2,
  QrCode,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  XCircle,
} from "lucide-react";

import {
  attendanceErrorAction,
  fetchAttendanceRegister,
  type AttendanceApiError,
  type AttendanceRegisterResponse,
  type BadgeTone,
} from "@/components/attendance/attendance-ui";
import { createCameraController, createFrameScanner, decodeSize, type CameraController, type CameraState, type FrameLike } from "@/components/attendance/qr-camera";
import {
  checkScanPayload,
  createDebouncedRefresh,
  createScanQueue,
  formatScanTime,
  payloadProblemMessage,
  registerPath,
  scannerAvailability,
  type ScanFeedEntry,
  type ScanQueue,
  type ScanQueueSnapshot,
  type ScannerAvailability,
} from "@/components/attendance/qr-scanner-logic";

// =========================================================================================
// Views (pure: rendered with react-dom/server in the tests)
// =========================================================================================

export const SCANNER_HEADING_ID = "qr-scanner-heading";
export const MANUAL_INPUT_ID = "qr-scanner-manual-input";
export const LEAVE_CONFIRM_ID = "qr-scanner-leave-confirm";
export const CAMERA_ERROR_ID = "qr-scanner-camera-error";

const TONE_CLASSES: Record<BadgeTone, string> = {
  positive: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  warning: "bg-amber-50 text-amber-900 ring-amber-200",
  danger: "bg-rose-50 text-rose-800 ring-rose-200",
  info: "bg-sky-50 text-sky-900 ring-sky-200",
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
};

function ToneIcon({ tone }: { tone: BadgeTone }) {
  const props = { size: 16, "aria-hidden": true, className: "shrink-0" } as const;
  if (tone === "positive") return <CheckCircle2 {...props} />;
  if (tone === "warning") return <AlertTriangle {...props} />;
  if (tone === "danger") return <XCircle {...props} />;
  if (tone === "info") return <Info {...props} />;
  return <CircleHelp {...props} />;
}

export function ScannerHeader({ register, onBack }: { register: AttendanceRegisterResponse; onBack?: () => void }) {
  const { summary } = register;
  return (
    <section className="rounded-2xl bg-[#112D5C] p-4 text-white shadow-sm" aria-labelledby={SCANNER_HEADING_ID}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/70">QR attendance scanner</p>
      <h1 id={SCANNER_HEADING_ID} tabIndex={-1} className="mt-1 break-words text-lg font-bold outline-none sm:text-xl">
        {register.lecture.title}
      </h1>
      <p className="mt-2 text-xs text-white/85">
        Present {summary.recordStatus.PRESENT} · Late {summary.recordStatus.LATE} · Pending reviews {summary.pendingReviews} · Students {summary.students}
      </p>
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="mt-3 inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-[#112D5C] hover:opacity-90"
        >
          <ArrowLeft size={15} aria-hidden />
          Close scanner and return to the register
        </button>
      ) : null}
    </section>
  );
}

export function ScannerUnavailableView({ availability, onRefresh }: { availability: Exclude<ScannerAvailability, { available: true }>; onRefresh?: () => void }) {
  const icon = availability.reason === "NOT_OPEN" ? <Clock size={20} aria-hidden /> : availability.reason === "UNCONFIGURED" || availability.reason === "UNAVAILABLE" ? <ShieldAlert size={20} aria-hidden /> : <Ban size={20} aria-hidden />;
  return (
    <section role="status" aria-label="Scanning unavailable" className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="flex items-center gap-2 text-base font-semibold text-slate-900">
        <span className="text-[#112D5C]">{icon}</span>
        {availability.title}
      </p>
      <p className="text-sm text-slate-700">{availability.message}</p>
      {availability.reason === "NOT_OPEN" && onRefresh ? (
        <button type="button" onClick={onRefresh} className="inline-flex min-h-[44px] w-fit items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50">
          <RefreshCw size={14} aria-hidden />
          Check again
        </button>
      ) : null}
    </section>
  );
}

export function CameraSection({
  camera,
  disabled,
  onStart,
  onStop,
  videoRef,
  hint,
}: {
  camera: CameraState;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
  videoRef?: RefObject<HTMLVideoElement>;
  hint?: string | null;
}) {
  const live = camera.phase === "running" || camera.phase === "starting";
  return (
    <section aria-labelledby="qr-camera-heading" className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="qr-camera-heading" className="flex items-center gap-2 text-base font-semibold text-slate-900">
          <Camera size={18} aria-hidden className="text-[#112D5C]" />
          Camera
        </h2>
        {live ? (
          <button type="button" onClick={onStop} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50">
            <CameraOff size={15} aria-hidden />
            Stop camera
          </button>
        ) : (
          <button
            type="button"
            onClick={onStart}
            disabled={disabled}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-[#112D5C] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Camera size={15} aria-hidden />
            Start camera
          </button>
        )}
      </div>
      <div className={`relative overflow-hidden rounded-xl bg-slate-900 ${live ? "" : "hidden"}`}>
        <video ref={videoRef} muted playsInline autoPlay aria-label="Camera preview" className="aspect-[4/3] w-full object-cover" />
        {camera.phase === "starting" ? (
          <p className="absolute inset-0 flex items-center justify-center gap-2 text-sm font-semibold text-white">
            <Loader2 size={16} className="animate-spin" aria-hidden />
            Starting the camera…
          </p>
        ) : null}
      </div>
      <p className="text-xs text-slate-600" role="status">
        {camera.phase === "running"
          ? "Point the camera at a student's QR code. Each code is sent once; results appear below."
          : camera.phase === "starting"
            ? "Starting the camera. Allow camera access if your browser asks."
            : camera.phase === "error"
              ? ""
              : "The camera starts only when you press Start camera."}
      </p>
      {camera.phase === "error" ? (
        <p id={CAMERA_ERROR_ID} tabIndex={-1} role="alert" className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900 outline-none">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          {camera.message}
        </p>
      ) : null}
      {hint ? (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
          {hint}
        </p>
      ) : null}
    </section>
  );
}

export function ManualEntryForm({
  value,
  problem,
  disabled,
  onChange,
  onSubmit,
  inputRef,
}: {
  value: string;
  problem: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  inputRef?: RefObject<HTMLInputElement>;
}) {
  const handle = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <section aria-labelledby="qr-manual-heading" className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 id="qr-manual-heading" className="flex items-center gap-2 text-base font-semibold text-slate-900">
        <Keyboard size={18} aria-hidden className="text-[#112D5C]" />
        Manual or handheld scanner
      </h2>
      <form onSubmit={handle} className="flex flex-col gap-2 sm:flex-row sm:items-start" noValidate>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={MANUAL_INPUT_ID} className="text-sm font-medium text-slate-800">
            QR code text
          </label>
          <input
            id={MANUAL_INPUT_ID}
            ref={inputRef}
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="send"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? "qr-manual-problem qr-manual-help" : "qr-manual-help"}
            className="min-h-[44px] w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:border-[#112D5C] focus:outline-none focus:ring-2 focus:ring-[#112D5C]/30 disabled:bg-slate-100"
          />
          <p id="qr-manual-help" className="text-xs text-slate-600">
            Click here and use a handheld scanner (it types the code and presses Enter), or type the code and press Send.
          </p>
          {problem ? (
            <p id="qr-manual-problem" role="alert" className="text-sm font-medium text-rose-800">
              {problem}
            </p>
          ) : null}
        </div>
        <button
          type="submit"
          disabled={disabled}
          className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg bg-[#112D5C] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 sm:mt-6"
        >
          <QrCode size={15} aria-hidden />
          Send
        </button>
      </form>
    </section>
  );
}

export function QueueStatus({ snapshot, now }: { snapshot: ScanQueueSnapshot; now: number }) {
  const sending = snapshot.pending.find((p) => p.state !== "WAITING");
  const waiting = snapshot.pending.filter((p) => p.state === "WAITING").length;
  const pausedSeconds = snapshot.pausedUntil !== null ? Math.max(0, Math.ceil((snapshot.pausedUntil - now) / 1000)) : 0;
  if (!sending && waiting === 0 && pausedSeconds === 0 && !snapshot.signedOut) return null;
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-800">
      {sending ? (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {sending.state === "RETRYING" ? `Connection problem: trying again (attempt ${sending.attempt})…` : "Sending a scan…"}
        </span>
      ) : null}
      {waiting > 0 ? <span>{`${waiting} scan${waiting === 1 ? "" : "s"} waiting.`}</span> : null}
      {pausedSeconds > 0 ? <span>{`Too many scans: sending resumes in about ${pausedSeconds} s.`}</span> : null}
      {snapshot.signedOut ? <span>Your session has expired. Sign in again; scans waiting here were not sent.</span> : null}
    </p>
  );
}

export function ResultsFeed({ entries, onRetry, disabled }: { entries: ScanFeedEntry[]; onRetry: (id: string) => void; disabled?: boolean }) {
  return (
    <section aria-labelledby="qr-results-heading" className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 id="qr-results-heading" className="text-base font-semibold text-slate-900">
        Recent scans
      </h2>
      {entries.length === 0 ? (
        <p className="text-sm text-slate-600">No scans yet. Results appear here, newest first. They are not kept after you leave this page.</p>
      ) : (
        <ol className="flex flex-col gap-2" aria-label="Recent scan results, newest first">
          {entries.map((entry) => {
            const time = formatScanTime(entry.receivedAt);
            return (
              <li key={entry.id} className="flex flex-col gap-1 rounded-xl border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${TONE_CLASSES[entry.description.tone]}`}>
                    <ToneIcon tone={entry.description.tone} />
                    {entry.description.label}
                  </span>
                  <span className="text-sm font-semibold text-slate-900">{entry.description.title}</span>
                </div>
                {entry.student ? (
                  <p className="text-sm text-slate-800">
                    <span className="font-medium">{entry.student.name}</span>
                    {entry.student.registrationNumber ? <span className="text-slate-600">{` · Reg. no. ${entry.student.registrationNumber}`}</span> : null}
                  </p>
                ) : null}
                <p className="text-sm text-slate-700">{entry.description.detail}</p>
                <p className="text-xs text-slate-500">
                  {time ? `Received ${time}` : "No server time (not confirmed)"}
                  {entry.replayed ? " · Confirmed on a repeated send (recorded once)" : ""}
                  {entry.source === "MANUAL" ? " · Manual entry" : " · Camera"}
                </p>
                {entry.retryable ? (
                  <button
                    type="button"
                    onClick={() => onRetry(entry.id)}
                    disabled={disabled}
                    className="inline-flex min-h-[44px] w-fit items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RotateCcw size={14} aria-hidden />
                    Try again
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function LeaveConfirmation({ pending, onStay, onLeave }: { pending: number; onStay: () => void; onLeave: () => void }) {
  return (
    <section id={LEAVE_CONFIRM_ID} tabIndex={-1} role="alert" aria-label="Scans still being sent" className="flex flex-col gap-2 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950 outline-none">
      <p className="text-sm font-semibold">{`${pending} scan${pending === 1 ? " is" : "s are"} still being sent.`}</p>
      <p className="text-sm">If you leave now, you will not see their results, and scans not yet sent are dropped. Scans the server already received stay recorded.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onStay} className="min-h-[44px] rounded-lg bg-[#112D5C] px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
          Stay on the scanner
        </button>
        <button type="button" onClick={onLeave} className="min-h-[44px] rounded-lg border border-amber-400 px-4 py-2 text-sm font-semibold hover:bg-amber-100">
          Leave anyway
        </button>
      </div>
    </section>
  );
}

export function ScannerErrorView({ error, onRetry, registerHref }: { error: AttendanceApiError; onRetry?: () => void; registerHref: string }) {
  const action = attendanceErrorAction(error.code);
  const notFound = error.code === "LECTURE_NOT_FOUND";
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
      <p className="text-lg font-semibold text-slate-900">{notFound ? "Lecture not found" : action === "SIGN_IN" ? "Please sign in again" : "The scanner could not be loaded"}</p>
      <p className="max-w-md text-sm text-slate-600">{notFound ? "This lecture does not exist or is not one of your lectures." : error.message}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {action === "SIGN_IN" ? (
          <Link href="/login" className="min-h-[44px] rounded-lg bg-[#112D5C] px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
            Sign in
          </Link>
        ) : null}
        {(action === "RETRY" || action === "RELOAD_PAGE") && onRetry ? (
          <button type="button" onClick={onRetry} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-[#112D5C] px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
            <RefreshCw size={14} aria-hidden />
            Try again
          </button>
        ) : null}
        <Link href={notFound ? "/dashboard/attendance" : registerHref} className="min-h-[44px] rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
          {notFound ? "Back to attendance" : "Back to the register"}
        </Link>
      </div>
    </div>
  );
}

export type ScannerViewProps = {
  register: AttendanceRegisterResponse;
  availability: ScannerAvailability;
  refreshFailed: boolean;
  camera: CameraState;
  hint: string | null;
  manualValue: string;
  manualProblem: string | null;
  queue: ScanQueueSnapshot;
  now: number;
  announcement: string;
  leaveConfirm: boolean;
  videoRef?: RefObject<HTMLVideoElement>;
  inputRef?: RefObject<HTMLInputElement>;
  onBack: () => void;
  onStay: () => void;
  onLeave: () => void;
  onRefresh: () => void;
  onStartCamera: () => void;
  onStopCamera: () => void;
  onManualChange: (value: string) => void;
  onManualSubmit: () => void;
  onRetry: (id: string) => void;
};

/** The whole scanner page from its state (no effects). */
export function ScannerView(props: ScannerViewProps) {
  const { availability, queue } = props;
  const inputDisabled = !availability.available || queue.signedOut;
  return (
    <div className="flex flex-col gap-4">
      <ScannerHeader register={props.register} onBack={props.onBack} />
      {props.leaveConfirm ? <LeaveConfirmation pending={queue.pending.length} onStay={props.onStay} onLeave={props.onLeave} /> : null}
      {props.refreshFailed ? (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          The register could not be refreshed. The counts above may be out of date; scanning still checks everything on the server.
        </p>
      ) : null}
      {availability.available ? null : <ScannerUnavailableView availability={availability} onRefresh={props.onRefresh} />}
      <CameraSection camera={props.camera} disabled={inputDisabled} onStart={props.onStartCamera} onStop={props.onStopCamera} videoRef={props.videoRef} hint={props.hint} />
      <ManualEntryForm value={props.manualValue} problem={props.manualProblem} disabled={inputDisabled} onChange={props.onManualChange} onSubmit={props.onManualSubmit} inputRef={props.inputRef} />
      <QueueStatus snapshot={queue} now={props.now} />
      <ResultsFeed entries={queue.feed} onRetry={props.onRetry} disabled={queue.signedOut} />
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {props.announcement}
      </p>
    </div>
  );
}

/** The screen-reader announcement for the newest result. */
export function announcementFor(entry: ScanFeedEntry | undefined): string {
  if (!entry) return "";
  return `${entry.description.title}${entry.student ? `: ${entry.student.name}` : ""}. ${entry.description.detail}`;
}

// =========================================================================================
// The panel (state and effects)
// =========================================================================================

type LoadState = { kind: "loading" } | { kind: "error"; error: AttendanceApiError } | { kind: "ready"; register: AttendanceRegisterResponse };

const EMPTY_SNAPSHOT: ScanQueueSnapshot = { pending: [], feed: [], pausedUntil: null, signedOut: false };
const NOT_OPEN_RECHECK_LIMIT_MS = 6 * 60 * 60 * 1000;

type Decoder = (data: Uint8ClampedArray, width: number, height: number, options?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" }) => { data: string } | null;

export function QrScannerPanel({ lectureId }: { lectureId: string }) {
  const router = useRouter();
  const registerHref = registerPath(lectureId);

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [camera, setCamera] = useState<CameraState>({ phase: "idle" });
  const [hint, setHint] = useState<string | null>(null);
  const [manualValue, setManualValue] = useState("");
  const [manualProblem, setManualProblem] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ScanQueueSnapshot>(EMPTY_SNAPSHOT);
  const [now, setNow] = useState(() => Date.now());
  const [leaveConfirm, setLeaveConfirm] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const decoderRef = useRef<Decoder | null>(null);
  const queueRef = useRef<ScanQueue | null>(null);
  const cameraRef = useRef<CameraController | null>(null);
  const refresherRef = useRef<ReturnType<typeof createDebouncedRefresh> | null>(null);
  const loadSeq = useRef(0);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Register load (a refresh keeps the shown register on failure) ----
  const load = useCallback(
    async (mode: "initial" | "refresh"): Promise<boolean> => {
      const mine = ++loadSeq.current;
      if (mode === "initial") setState({ kind: "loading" });
      const result = await fetchAttendanceRegister(lectureId);
      if (mine !== loadSeq.current) return false;
      if (result.ok) {
        setState({ kind: "ready", register: result.data });
        setRefreshFailed(false);
        return true;
      }
      if (mode === "initial") setState({ kind: "error", error: result });
      else setRefreshFailed(true);
      return false;
    },
    [lectureId]
  );

  const showHint = useCallback((message: string) => {
    setHint(message);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 4_000);
  }, []);

  // ---- Queue, refresher, camera: one per mount; everything dropped on unmount ----
  useEffect(() => {
    void load("initial");
    const refresher = createDebouncedRefresh({ refresh: () => load("refresh") });
    refresherRef.current = refresher;
    const queue = createScanQueue({
      lectureId,
      onChange: setSnapshot,
      onEvent: (event) => {
        if (event.kind === "STATE_CHANGED") void refresher.flush();
        else refresher.schedule();
      },
    });
    queueRef.current = queue;

    const frames = createFrameScanner({
      isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
      readFrame: (): FrameLike | null => {
        const video = videoRef.current;
        if (!video || video.readyState < 2 || video.videoWidth === 0) return null;
        const size = decodeSize(video.videoWidth, video.videoHeight);
        const canvas = canvasRef.current ?? (canvasRef.current = document.createElement("canvas"));
        if (canvas.width !== size.width) canvas.width = size.width;
        if (canvas.height !== size.height) canvas.height = size.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return null;
        context.drawImage(video, 0, 0, size.width, size.height);
        const image = context.getImageData(0, 0, size.width, size.height);
        return { data: image.data, width: image.width, height: image.height };
      },
      decode: (frame) => decoderRef.current?.(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" })?.data ?? null,
      onDecoded: (text) => {
        const check = checkScanPayload(text);
        if (!check.ok) {
          showHint("That QR code is not a student attendance QR code.");
          return;
        }
        queue.enqueue(check.payload, "CAMERA");
      },
    });

    const cameraController = createCameraController({
      mediaDevices: typeof navigator !== "undefined" ? navigator.mediaDevices : undefined,
      isSecureContext: typeof window !== "undefined" ? window.isSecureContext : undefined,
      attach: async (stream) => {
        const video = videoRef.current;
        if (!video) throw new Error("No video element.");
        video.srcObject = stream as MediaStream;
        await video.play();
      },
      detach: () => {
        const video = videoRef.current;
        if (video) video.srcObject = null;
      },
      startDecoding: () => {
        frames.start();
        return () => frames.stop();
      },
      onChange: setCamera,
    });
    cameraRef.current = cameraController;

    const onPageHide = () => cameraController.stop();
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      cameraController.dispose();
      frames.stop();
      queue.dispose();
      refresher.dispose();
      queueRef.current = null;
      cameraRef.current = null;
      refresherRef.current = null;
      decoderRef.current = null;
      canvasRef.current = null;
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
  }, [lectureId, load, showHint]);

  const register = state.kind === "ready" ? state.register : null;
  const availability = useMemo<ScannerAvailability | null>(() => (register ? scannerAvailability(register) : null), [register]);

  // Scanning stops when the server says the QR window is no longer open.
  useEffect(() => {
    if (availability && !availability.available) cameraRef.current?.stop();
  }, [availability]);

  // Before the window opens: check again at opensAt (when it is within a few hours).
  useEffect(() => {
    if (!availability || availability.available || availability.reason !== "NOT_OPEN" || !availability.opensAt) return;
    const wait = new Date(availability.opensAt).getTime() - Date.now() + 1_000;
    if (!(wait > 0 && wait < NOT_OPEN_RECHECK_LIMIT_MS)) return;
    const timer = setTimeout(() => void load("refresh"), wait);
    return () => clearTimeout(timer);
  }, [availability, load]);

  // A clock for the rate-limit countdown (only while paused).
  useEffect(() => {
    if (snapshot.pausedUntil === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [snapshot.pausedUntil]);

  // The browser's own prompt while scans are still being sent.
  const pendingCount = snapshot.pending.length;
  useEffect(() => {
    if (pendingCount === 0) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [pendingCount]);

  // Focus: the heading once loaded; the camera error when it appears; the leave confirmation.
  const ready = state.kind === "ready";
  useEffect(() => {
    if (ready) document.getElementById(SCANNER_HEADING_ID)?.focus();
  }, [ready]);
  useEffect(() => {
    if (camera.phase === "error") document.getElementById(CAMERA_ERROR_ID)?.focus();
  }, [camera]);
  useEffect(() => {
    if (leaveConfirm) document.getElementById(LEAVE_CONFIRM_ID)?.focus();
  }, [leaveConfirm]);

  const startCamera = useCallback(() => {
    if (!decoderRef.current) {
      void import("jsqr")
        .then((mod) => {
          decoderRef.current = mod.default as unknown as Decoder;
        })
        .catch(() => showHint("The QR decoder could not be loaded. Reload the page, or use the manual entry."));
    }
    void cameraRef.current?.start();
  }, [showHint]);
  const stopCamera = useCallback(() => cameraRef.current?.stop(), []);

  const submitManual = useCallback(() => {
    const queue = queueRef.current;
    if (!queue) return;
    const check = checkScanPayload(manualValue);
    if (!check.ok) {
      setManualProblem(payloadProblemMessage(check.problem));
      if (check.problem === "TOO_LONG") setManualValue("");
      return;
    }
    const result = queue.enqueue(check.payload, "MANUAL");
    setManualValue("");
    setManualProblem(
      result === "DUPLICATE" ? "This QR code is already being sent." : result === "FULL" ? "Too many scans are waiting. Wait a moment, then scan again." : null
    );
    inputRef.current?.focus();
  }, [manualValue]);

  const retry = useCallback((id: string) => void queueRef.current?.retry(id), []);

  const leave = useCallback(() => {
    cameraRef.current?.dispose();
    queueRef.current?.dispose();
    setSnapshot(EMPTY_SNAPSHOT);
    setManualValue("");
    router.push(registerHref);
  }, [router, registerHref]);

  const back = useCallback(() => {
    if ((queueRef.current?.pendingCount() ?? 0) > 0) setLeaveConfirm(true);
    else leave();
  }, [leave]);

  if (state.kind === "loading") {
    return (
      <div role="status" className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
        <RefreshCw size={16} className="animate-spin text-[#112D5C]" aria-hidden />
        Loading the attendance register…
      </div>
    );
  }
  if (state.kind === "error" || !register || !availability) {
    return <ScannerErrorView error={state.kind === "error" ? state.error : { ok: false, status: 0, code: "INVALID_RESPONSE", message: "" }} onRetry={() => void load("initial")} registerHref={registerHref} />;
  }

  return (
    <ScannerView
      register={register}
      availability={availability}
      refreshFailed={refreshFailed}
      camera={camera}
      hint={hint}
      manualValue={manualValue}
      manualProblem={manualProblem}
      queue={snapshot}
      now={now}
      announcement={announcementFor(snapshot.feed[0])}
      leaveConfirm={leaveConfirm}
      videoRef={videoRef}
      inputRef={inputRef}
      onBack={back}
      onStay={() => setLeaveConfirm(false)}
      onLeave={leave}
      onRefresh={() => void load("refresh")}
      onStartCamera={startCamera}
      onStopCamera={stopCamera}
      onManualChange={(value) => {
        setManualValue(value);
        setManualProblem(null);
      }}
      onManualSubmit={submitManual}
      onRetry={retry}
    />
  );
}
