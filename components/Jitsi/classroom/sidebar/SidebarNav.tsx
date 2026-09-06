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
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type SidebarNavProps = {
  activePanel: string | null;
  onPanelChange: (panel: string) => void;
  /** Show the lecture-bound Notes / Assignments / Quizzes tools (a lecture is on the session). */
  showLectureTools?: boolean;
  /** Show the Attendance tool (teacher only). */
  showAttendance?: boolean;
  /** Unread chat message count shown as a badge on the Chat button. */
  chatUnread?: number;
  /** Rail color scheme: navy/blue for the teacher, green for the student. */
  variant?: "teacher" | "student";
  /** Show the Settings tool — video quality / audio picker (teacher only). */
  showSettings?: boolean;
  /** Applies the chosen frame height (px) as the send/receive video quality. */
  onSetVideoQuality?: (heightPx: number) => void;
  /** Enables/disables noise suppression on the teacher's own microphone. */
  onSetNoiseSuppression?: (enabled: boolean) => void;
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

const VIDEO_QUALITY_OPTIONS: { label: string; height: number }[] = [
  { label: "1080p", height: 1080 },
  { label: "720p", height: 720 },
  { label: "480p", height: 480 },
  { label: "320p", height: 320 },
  { label: "180p", height: 180 },
];

const VIDEO_QUALITY_STORAGE_KEY = "sl-classroom-teacher-video-quality";

function readStoredVideoQuality(): number | null {
  try {
    const raw = localStorage.getItem(VIDEO_QUALITY_STORAGE_KEY);
    const value = raw ? Number(raw) : null;
    return value && VIDEO_QUALITY_OPTIONS.some((o) => o.height === value) ? value : null;
  } catch {
    return null;
  }
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
  chatUnread = 0,
  variant = "teacher",
  showSettings = false,
  onSetVideoQuality,
  onSetNoiseSuppression,
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
    // Best-effort: the underlying Jitsi call may still be connecting at this
    // point (a harmless no-op if so — the teacher can just re-pick).
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
    setSettingsPos({
      bottom: window.innerHeight - rect.top + 8,
      right: Math.max(8, window.innerWidth - rect.right),
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
        relative
        mb-3
        flex h-12 w-12
        items-center justify-center
        rounded-xl
        transition-all duration-200
        ${(panel ? activePanel === panel : active) ? theme.active : theme.idle}
      `}
    >
      <Icon size={24} />
      {badge ? (
        <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
          {badge > 9 ? "9+" : badge}
        </span>
      ) : null}
    </button>
  );

  return (
    <div
      className={`flex h-full w-[72px] flex-col items-center overflow-y-auto scrollbar-none border-r py-5 ${theme.border}`}
    >
      <RailButton panel="participants" label="Participants" icon={Users} />
      {showAttendance ? (
        <RailButton panel="attendance" label="Attendance" icon={ClipboardCheck} />
      ) : null}
      <RailButton
        panel="chat"
        label="Chat"
        icon={MessageSquare}
        badge={chatUnread}
      />

      {showLectureTools ? (
        <>
          <div className={`my-1 h-px w-8 ${theme.divider}`} />
          <RailButton panel="notes" label="Notes" icon={FileText} />
          <RailButton panel="assignments" label="Assignments" icon={ClipboardList} />
          <RailButton panel="quiz" label="Quizzes" icon={ListChecks} />
        </>
      ) : null}

      {showSettings ? (
        <div className="mt-auto">
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
            className="fixed z-50 w-64 rounded-2xl border border-[#1E293B] bg-[#112D5C] p-3 shadow-2xl"
            style={{ bottom: settingsPos.bottom, right: settingsPos.right }}
          >
            <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-[#94A3B8]">
              Video Quality
            </p>
            <div className="space-y-1">
              {VIDEO_QUALITY_OPTIONS.map((option) => (
                <button
                  key={option.height}
                  type="button"
                  onClick={() => {
                    setSelectedQuality(option.height);
                    onSetVideoQuality?.(option.height);
                    try {
                      localStorage.setItem(
                        VIDEO_QUALITY_STORAGE_KEY,
                        String(option.height)
                      );
                    } catch {
                      /* private mode — selection just won't persist */
                    }
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
              Sets the quality students receive your video at.
            </p>

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
          </div>
        </>
      ) : null}
    </div>
  );
}
