"use client";

import { useEffect, useRef, useState } from "react";
import {
  Users,
  ClipboardCheck,
  MessageSquare,
  FileText,
  ClipboardList,
  ListChecks,
  Settings,
  Check,
  PenTool,
  UsersRound,
  ScanEye,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { TeachingModeStatus, VideoTelemetryStatus } from "../../hooks/useJitsi";
import VideoDiagnosticsSection from "./VideoDiagnosticsSection";
import {
  DEFAULT_TEACHING_FRAME_RATE,
  parseStoredVideoQuality,
  readStorage,
  TEACHER_VIDEO_QUALITY_HEIGHTS,
  TEACHING_FRAME_RATES,
  VIDEO_QUALITY_STORAGE_KEY,
  writeStorage,
} from "../../teacher-camera-preferences.mjs";

type SidebarNavProps = {
  activePanel: string | null;
  onPanelChange: (panel: string) => void;
  /** Show the lecture-bound Notes / Assignments / Quizzes tools (a lecture is on the session). */
  showLectureTools?: boolean;
  /** Show the Attendance tool (teacher only). */
  showAttendance?: boolean;
  /** Show the Camera Monitoring tool (teacher only). */
  showMonitoring?: boolean;
  /** Unread chat message count shown as a badge on the Chat button. */
  chatUnread?: number;
  /** Rail color scheme: navy/blue for the teacher, green for the student. */
  variant?: "teacher" | "student";
  /** Show the Settings tool — video quality / audio picker (teacher only). */
  showSettings?: boolean;
  /**
   * The chosen maximum frame height (px) for the video the teacher sends
   * (Jitsi still lowers it for the network). useJitsi keeps it and applies
   * it on every conference join.
   */
  onSetVideoQuality?: (heightPx: number) => void;
  /** Enables/disables noise suppression on the teacher's own microphone. */
  onSetNoiseSuppression?: (enabled: boolean) => void;
  /** Teaching Mode (teacher's camera tuned for handwriting): on / off. */
  teachingMode?: boolean;
  /** What Teaching Mode applied to the camera, as last reported. */
  teachingModeStatus?: TeachingModeStatus | null;
  /** Shows the Teaching Mode toggle (teacher only). */
  onSetTeachingMode?: (enabled: boolean) => void;
  /** Teaching Mode's frame-rate cap (15 / 24 / 30; saved preference). */
  teachingFps?: number;
  onSetTeachingFps?: (maxFps: number) => void;
  /** Teaching Mode's contentHint "detail" (saved preference). */
  teachingDetailHint?: boolean;
  onSetTeachingDetailHint?: (enabled: boolean) => void;
  /** Video diagnostics (read-only WebRTC stats): on / off and the latest snapshot. */
  videoDiagnostics?: boolean;
  videoTelemetry?: VideoTelemetryStatus | null;
  videoTelemetryLabel?: (participantId: string) => string;
  /** Shows the video diagnostics section (teacher only). */
  onSetVideoDiagnostics?: (enabled: boolean) => void;
  onCopyVideoDiagnostics?: () => Promise<boolean>;
};

const VARIANTS = {
  teacher: {
    border: "border-[#1E293B]",
    divider: "bg-[#1E293B]",
    active: "bg-[#172554] text-[#60A5FA] shadow-lg shadow-[#172554]/40",
    idle: "text-[#94A3B8] hover:bg-[#1E293B] hover:text-[#E2E8F0]",
  },
  student: {
    border: "border-[#1C332B]",
    divider: "bg-[#1C332B]",
    active: "bg-[#22392F] text-white shadow-lg shadow-[#22392F]/40",
    idle: "text-white/90 hover:bg-[#22392F] hover:text-white",
  },
} as const;

const VIDEO_QUALITY_OPTIONS: { label: string; height: number }[] =
  TEACHER_VIDEO_QUALITY_HEIGHTS.map((height) => ({ label: `${height}p`, height }));

function readStoredVideoQuality(): number | null {
  return parseStoredVideoQuality(readStorage(VIDEO_QUALITY_STORAGE_KEY));
}

/** One line under the Teaching Mode toggle: what is applied right now. */
function describeTeachingMode(status: TeachingModeStatus | null | undefined): string {
  if (!status || !status.enabled) {
    return "Turning on…";
  }

  if (!status.active) {
    return "Waiting for your teacher permissions…";
  }

  if (!status.camera) {
    return "Applies when your camera is on.";
  }

  if (status.frameRate === "pending" || status.frameRate === null || status.contentHint === null) {
    return "Applying…";
  }

  // An older custom.js reports no maxFps: it always applies 15, whatever
  // was requested.
  const cap = status.maxFps ?? 15;
  const hintOk = status.contentHint === "applied";
  const hintOff = status.contentHint === "disabled";
  const frameRateOk = status.frameRate === "applied" || status.frameRate === "kept";
  const fps = status.fps !== null ? `${Math.round(status.fps)} fps` : `up to ${cap} fps`;

  if (frameRateOk && hintOff) {
    return `On: ${fps} (detail hint off).`;
  }

  if (hintOk && frameRateOk) {
    return `On: fine detail first, ${fps}.`;
  }

  if (frameRateOk) {
    return `On: ${fps} (detail hint not supported in this browser).`;
  }

  if (hintOk) {
    return `On: fine detail first (${cap} fps cap not supported by this camera).`;
  }

  if (hintOff) {
    return `${cap} fps cap not supported by this camera (detail hint off).`;
  }

  return "Not supported by this browser or camera.";
}

const NOISE_SUPPRESSION_STORAGE_KEY = "sl-classroom-teacher-noise-suppression";

/** `null` means "the teacher has never touched this" — don't auto-apply anything. */
function readStoredNoiseSuppression(): boolean | null {
  try {
    const raw = localStorage.getItem(NOISE_SUPPRESSION_STORAGE_KEY);
    return raw === null ? null : raw === "true";
  } catch {
    return null;
  }
}

export default function SidebarNav({
  activePanel,
  onPanelChange,
  showLectureTools = false,
  showAttendance = false,
  showMonitoring = false,
  chatUnread = 0,
  variant = "teacher",
  showSettings = false,
  onSetVideoQuality,
  onSetNoiseSuppression,
  teachingMode = false,
  teachingModeStatus = null,
  onSetTeachingMode,
  teachingFps = DEFAULT_TEACHING_FRAME_RATE,
  onSetTeachingFps,
  teachingDetailHint = true,
  onSetTeachingDetailHint,
  videoDiagnostics = false,
  videoTelemetry = null,
  videoTelemetryLabel,
  onSetVideoDiagnostics,
  onCopyVideoDiagnostics,
}: SidebarNavProps) {
  const theme = VARIANTS[variant];

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  // Remembers the teacher's last-chosen video quality (localStorage) so it
  // stays selected — and gets re-applied — across reloads/rejoins.
  const [selectedQuality, setSelectedQuality] = useState<number | null>(() =>
    readStoredVideoQuality()
  );
  const [noiseSuppression, setNoiseSuppression] = useState<boolean>(
    () => readStoredNoiseSuppression() ?? false
  );
  const [settingsPos, setSettingsPos] = useState<{ bottom: number; right: number } | null>(null);

  const appliedStoredQualityRef = useRef(false);
  useEffect(() => {
    if (appliedStoredQualityRef.current) return;
    if (!onSetVideoQuality || selectedQuality === null) return;
    appliedStoredQualityRef.current = true;
    // Handed over once: useJitsi keeps it and sends it on every conference
    // join (also when Jitsi is not ready yet at this point).
    onSetVideoQuality(selectedQuality);
  }, [onSetVideoQuality, selectedQuality]);

  const appliedStoredNoiseSuppressionRef = useRef(false);
  useEffect(() => {
    if (appliedStoredNoiseSuppressionRef.current) return;
    if (!onSetNoiseSuppression) return;
    const stored = readStoredNoiseSuppression();
    if (stored === null) return; // teacher never set a preference — leave Jitsi's default alone
    appliedStoredNoiseSuppressionRef.current = true;
    onSetNoiseSuppression(stored);
  }, [onSetNoiseSuppression]);

  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsPopoverRef = useRef<HTMLDivElement>(null);

  const placeSettingsPopover = () => {
    const rect = settingsButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const popoverWidth = Math.min(256, window.innerWidth - 16);
    setSettingsPos({
      bottom: window.innerHeight - rect.top + 8,
      right: Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - popoverWidth - 8)),
    });
  };

  useEffect(() => {
    if (!isSettingsOpen) return;

    placeSettingsPopover();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsSettingsOpen(false);
    }

    window.addEventListener("resize", placeSettingsPopover);
    window.addEventListener("scroll", placeSettingsPopover, true);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("resize", placeSettingsPopover);
      window.removeEventListener("scroll", placeSettingsPopover, true);
      document.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSettingsOpen]);

  const RailButton = ({
    panel,
    label,
    icon: Icon,
    badge,
    buttonRef,
    onClick,
    active,
  }: {
    panel?: string;
    label: string;
    icon: LucideIcon;
    badge?: number;
    buttonRef?: React.Ref<HTMLButtonElement>;
    onClick?: () => void;
    active?: boolean;
  }) => (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick ?? (() => panel && onPanelChange(panel))}
      title={label}
      className={`
        sl-nav-btn
        relative
        mb-2
        flex h-10 w-10
        items-center justify-center
        rounded-xl
        transition-all duration-200
        ${(panel ? activePanel === panel : active) ? theme.active : theme.idle}
      `}
    >
      <Icon size={20} />
      {badge ? (
        <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
          {badge > 9 ? "9+" : badge}
        </span>
      ) : null}
    </button>
  );

  return (
    <div
      // Rail on desktop / tablet / landscape phone, bottom bar on portrait phones
      // (see .sl-nav in globals.css).
      className={`sl-nav border-r ${theme.border}`}
    >
      <RailButton panel="participants" label="Participants" icon={Users} />
      {showAttendance ? (
        <RailButton panel="attendance" label="Attendance" icon={ClipboardCheck} />
      ) : null}
      {showMonitoring ? (
        <RailButton panel="monitoring" label="Camera Monitoring" icon={ScanEye} />
      ) : null}
      <RailButton
        panel="chat"
        label="Chat"
        icon={MessageSquare}
        badge={chatUnread}
      />
      <RailButton panel="breakoutRooms" label="Breakout Rooms" icon={UsersRound} />

      {showLectureTools ? (
        <>
          <div className={`sl-nav-divider my-1 h-px w-8 ${theme.divider}`} />
          <RailButton panel="notes" label="Notes" icon={FileText} />
          <RailButton panel="assignments" label="Assignments" icon={ClipboardList} />
          <RailButton panel="quiz" label="Quizzes" icon={ListChecks} />
          <RailButton panel="whiteboard" label="Whiteboard" icon={PenTool} />
        </>
      ) : null}

      {showSettings ? (
        <div className="sl-nav-settings mt-auto">
          <RailButton
            label="Settings"
            icon={Settings}
            buttonRef={settingsButtonRef}
            active={isSettingsOpen}
            onClick={() => setIsSettingsOpen((prev) => !prev)}
          />
        </div>
      ) : null}

      {isSettingsOpen && settingsPos ? (
        <>
          {/* Transparent click-catcher: most of the screen is the Jitsi meeting
              iframe, whose clicks never bubble to this document, so a
              document-level "outside click" listener would silently miss them. */}
          <button
            type="button"
            aria-label="Close"
            onClick={() => setIsSettingsOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            ref={settingsPopoverRef}
            className="fixed z-50 w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-2xl border border-[#1E293B] bg-[#112D5C] p-3 shadow-2xl"
            style={{
              bottom: settingsPos.bottom,
              right: settingsPos.right,
              // Never taller than the space above the button (short landscape screens scroll inside it).
              maxHeight: `calc(100dvh - ${settingsPos.bottom}px - 0.5rem)`,
            }}
          >
            <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-[#94A3B8]">
              Maximum send quality (adapts to network)
            </p>
            <div className="space-y-1">
              {VIDEO_QUALITY_OPTIONS.map((option) => (
                <button
                  key={option.height}
                  type="button"
                  onClick={() => {
                    setSelectedQuality(option.height);
                    onSetVideoQuality?.(option.height);
                    writeStorage(VIDEO_QUALITY_STORAGE_KEY, String(option.height));
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    selectedQuality === option.height
                      ? "bg-[#3B82F6]/15 text-[#F8FAFC]"
                      : "text-[#CBD5E1] hover:bg-[#1E293B]"
                  }`}
                >
                  {option.label}
                  {selectedQuality === option.height ? (
                    <Check size={14} className="text-[#3B82F6]" />
                  ) : null}
                </button>
              ))}
            </div>
            <p className="mt-2 px-1 text-[10px] leading-snug text-[#64748B]">
              The highest quality your video is sent at; Jitsi lowers it when
              the network or the students&apos; screens need less. It also
              limits the video you receive.
            </p>

            {onSetTeachingMode ? (
              <>
                <div className="my-3 h-px bg-[#1E293B]" />

                <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-[#94A3B8]">
                  Camera
                </p>
                <button
                  type="button"
                  role="switch"
                  aria-checked={teachingMode}
                  onClick={() => onSetTeachingMode(!teachingMode)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm text-[#CBD5E1] transition hover:bg-[#1E293B]"
                >
                  <span className="text-left">
                    <span className="block text-[#F8FAFC]">Teaching Mode</span>
                    <span className="block text-[10px] text-[#64748B]">
                      Sharper handwriting and whiteboards
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      teachingMode ? "bg-[#3B82F6]" : "bg-[#334155]"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        teachingMode ? "translate-x-4" : "translate-x-0.5"
                      }`}
                    />
                  </span>
                </button>
                {teachingMode ? (
                  <p
                    role="status"
                    className="mt-1 px-3 text-[10px] leading-snug text-[#94A3B8]"
                  >
                    {describeTeachingMode(teachingModeStatus)}
                    {selectedQuality !== null && selectedQuality < 720
                      ? " Choose 720p above for the clearest writing."
                      : ""}
                  </p>
                ) : null}

                {onSetTeachingFps ? (
                  <div className="mt-2 px-3">
                    <p className="pb-1 text-[10px] text-[#94A3B8]">Teaching Mode frame rate</p>
                    <div className="grid grid-cols-3 gap-1" role="group" aria-label="Teaching Mode frame rate">
                      {TEACHING_FRAME_RATES.map((fps) => (
                        <button
                          key={fps}
                          type="button"
                          aria-pressed={teachingFps === fps}
                          onClick={() => onSetTeachingFps(fps)}
                          className={`rounded-lg px-2 py-1.5 text-xs transition ${
                            teachingFps === fps
                              ? "bg-[#3B82F6]/15 text-[#F8FAFC] ring-1 ring-[#3B82F6]/60"
                              : "text-[#CBD5E1] hover:bg-[#1E293B]"
                          }`}
                        >
                          {fps} fps
                        </button>
                      ))}
                    </div>
                    <p className="pt-1 text-[10px] leading-snug text-[#64748B]">
                      Lower = sharper still writing; higher = smoother motion.
                    </p>
                  </div>
                ) : null}

                {onSetTeachingDetailHint ? (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={teachingDetailHint}
                    onClick={() => onSetTeachingDetailHint(!teachingDetailHint)}
                    className="mt-1 flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm text-[#CBD5E1] transition hover:bg-[#1E293B]"
                  >
                    <span className="text-left">
                      <span className="block text-xs text-[#F8FAFC]">Detail hint</span>
                      <span className="block text-[10px] text-[#64748B]">
                        Tells the browser to favour fine detail; may have little effect
                      </span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                        teachingDetailHint ? "bg-[#3B82F6]" : "bg-[#334155]"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          teachingDetailHint ? "translate-x-4" : "translate-x-0.5"
                        }`}
                      />
                    </span>
                  </button>
                ) : null}
              </>
            ) : null}

            <div className="my-3 h-px bg-[#1E293B]" />

            <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-[#94A3B8]">
              Audio
            </p>
            <button
              type="button"
              onClick={() => {
                const next = !noiseSuppression;
                setNoiseSuppression(next);
                onSetNoiseSuppression?.(next);
                try {
                  localStorage.setItem(
                    NOISE_SUPPRESSION_STORAGE_KEY,
                    String(next)
                  );
                } catch {
                  /* private mode — selection just won't persist */
                }
              }}
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm text-[#CBD5E1] transition hover:bg-[#1E293B]"
            >
              <span className="text-left">
                <span className="block text-[#F8FAFC]">Noise Suppression</span>
                <span className="block text-[10px] text-[#64748B]">
                  Reduces background noise on your mic
                </span>
              </span>
              <span
                aria-hidden="true"
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                  noiseSuppression ? "bg-[#3B82F6]" : "bg-[#334155]"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    noiseSuppression ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </span>
            </button>

            {onSetVideoDiagnostics ? (
              <VideoDiagnosticsSection
                enabled={videoDiagnostics}
                status={videoTelemetry}
                labelOf={videoTelemetryLabel ?? ((participantId) => `Participant ${participantId}`)}
                onToggle={onSetVideoDiagnostics}
                onCopy={onCopyVideoDiagnostics}
              />
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
