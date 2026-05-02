type UserRole = "teacher" | "student";

type LiveSessionControlBarProps = {
  role: UserRole;
  isLive: boolean;
  participantsCount: number;
  isAudioMuted: boolean;
  isVideoMuted: boolean;
  isChatOpen: boolean;
  isFilmStripOpen: boolean;
  isFullscreen: boolean;
  isBusy: boolean;
  onStartClass: () => void;
  onEndClass: () => void;
  onMuteAllStudents: () => void;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onToggleChat: () => void;
  onToggleFilmStrip: () => void;
  onToggleFullscreen: () => void;
};

export function LiveSessionControlBar({
  role,
  isLive,
  participantsCount,
  isAudioMuted,
  isVideoMuted,
  isChatOpen,
  isFilmStripOpen,
  isFullscreen,
  isBusy,
  onStartClass,
  onEndClass,
  onMuteAllStudents,
  onToggleAudio,
  onToggleVideo,
  onToggleChat,
  onToggleFilmStrip,
  onToggleFullscreen,
}: LiveSessionControlBarProps) {
  return (
    <div className="sticky top-0 z-20 rounded-2xl border border-black/10 bg-card/95 p-3 shadow-xl backdrop-blur dark:border-white/10">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
              isLive
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                : "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
            }`}
          >
            {isLive ? "LIVE" : "NOT STARTED"}
          </span>
          <span className="rounded-full border border-black/10 px-3 py-1 text-xs text-muted dark:border-white/10">
            Participants: {participantsCount}
          </span>
          <span className="rounded-full border border-black/10 px-3 py-1 text-xs capitalize text-muted dark:border-white/10">
            Role: {role}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {role === "teacher" && !isLive ? (
            <button
              type="button"
              onClick={onStartClass}
              disabled={isBusy}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Start Class
            </button>
          ) : null}

          <button
            type="button"
            onClick={onToggleAudio}
            disabled={!isLive || isBusy}
            className="rounded-lg border border-black/15 px-3 py-2 text-xs font-semibold transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/20 dark:hover:bg-white/5"
          >
            {isAudioMuted ? "Unmute Mic" : "Mute Mic"}
          </button>

          <button
            type="button"
            onClick={onToggleVideo}
            disabled={!isLive || isBusy}
            className="rounded-lg border border-black/15 px-3 py-2 text-xs font-semibold transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/20 dark:hover:bg-white/5"
          >
            {isVideoMuted ? "Start Video" : "Stop Video"}
          </button>

          {role === "teacher" ? (
            <button
              type="button"
              onClick={onMuteAllStudents}
              disabled={!isLive || isBusy}
              className="rounded-lg border border-black/15 px-3 py-2 text-xs font-semibold transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/20 dark:hover:bg-white/5"
            >
              Mute All Students
            </button>
          ) : null}

          <button
            type="button"
            onClick={onToggleChat}
            disabled={!isLive || isBusy}
            className="rounded-lg border border-black/15 px-3 py-2 text-xs font-semibold transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/20 dark:hover:bg-white/5"
          >
            {isChatOpen ? "Hide Chat" : "Toggle Chat"}
          </button>

          <button
            type="button"
            onClick={onToggleFilmStrip}
            disabled={!isLive || isBusy}
            className="rounded-lg border border-black/15 px-3 py-2 text-xs font-semibold transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/20 dark:hover:bg-white/5"
          >
            {isFilmStripOpen ? "Hide Filmstrip" : "Show Filmstrip"}
          </button>

          <button
            type="button"
            onClick={onToggleFullscreen}
            className="rounded-lg border border-black/15 px-3 py-2 text-xs font-semibold transition hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5"
          >
            {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
          </button>

          {role === "teacher" && isLive ? (
            <button
              type="button"
              onClick={onEndClass}
              disabled={isBusy}
              className="rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              End Class
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
