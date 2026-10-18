"use client";

import {
  useEffect,
  useRef,
  useImperativeHandle,
} from "react";

import type {
  BreakoutRoom,
  ChatMessage,
  CurrentRoomInfo,
  JitsiParticipant,
  JoinInfo,
  UserRole,
} from "../types";

import {
  studentToolbar,
  teacherToolbar,
} from "../constants/toolbar";

import {
  createBreakoutControls,
  isBreakoutSupported,
  mainRoomJidFallback,
  normalizeBreakoutRooms,
  type BreakoutControls,
} from "../breakout-utils";

import type { TeacherTilesState } from "./useTeacherTiles";
import { toYouTubeStreamStatus } from "../youtube-jibri";
import { fetchStagePhoto, toStageTeacher } from "../stage-teacher.mjs";

// A breakout-room switch fires `videoConferenceLeft` and then `videoConferenceJoined`
// (typically 1-3 s apart). A "left" is only treated as really leaving the class if no
// "joined" follows within this window, so a room switch never becomes a fake
// leave + rejoin in the attendance records.
const ROOM_SWITCH_GRACE_MS = 6000;

export type JitsiControls = BreakoutControls & {
  startRecording: () => void;
  stopRecording: () => void;
  startYouTubeLive: (
    streamKey: string,
    broadcastId: string,
    purpose:YouTubeStreamPurpose
  ) => void;
  stopYouTubeLive: () => void;

  /** Moderator: mute every remote participant's microphone. */
  muteEveryone: () => void;

  /**
   * Moderator: mute a single participant's mic (`muted = true`) or ask them to
   * unmute (`muted = false`). Jitsi does not allow silently force-unmuting a
   * participant, so unmute sends a request.
   */
  setParticipantAudioMuted: (
    participantId: string,
    muted: boolean
  ) => void;

  /** Send a chat message to everyone in the meeting (Jitsi group chat). */
  sendChatMessage: (message: string) => void;

  /**
   * Teacher only: sets the send (and receive) video resolution, in pixels of
   * frame height — e.g. 720, 480, 320, 180. Students receive the teacher's
   * video at this resolution.
   */
  setVideoQuality: (heightPx: number) => void;

  /** Enable/disable noise suppression on the local (teacher's) microphone track. */
  setNoiseSuppression: (enabled: boolean) => void;

  /** Moderator: end the Jitsi conference for every participant (teacher included). */
  endConference: () => void;

  /**
   * Teacher only: tells the teacher's own Jitsi iframe (custom.js) which
   * students' camera video it should receive, by Jitsi participant ID. `null`
   * turns the override off, so Jitsi picks what to receive by itself again.
   * Receive-side only: nothing is muted or changed for the students.
   */
  setReceiveSet: (participantIds: string[] | null) => void;

  /**
   * Teacher only: tells the teacher's own Jitsi iframe (custom.js) which
   * students' already-received camera tracks to show in the monitoring grid,
   * by Jitsi participant ID. `null` hides the grid. Display only: what is
   * received is still decided by setReceiveSet.
   */
  setMonitorView: (participantIds: string[] | null) => void;

  /**
   * Teacher only: shows (`true`) or hides (`false`) SL Classroom's own normal
   * mode view in the teacher's Jitsi iframe (custom.js): custom main stage plus
   * a custom filmstrip. Display only: what is received does not change. Has no
   * effect unless the app is built with NEXT_PUBLIC_SL_TEACHER_FILMSTRIP=true.
   */
  setTeacherView: (enabled: boolean) => void;

  /**
   * Teacher only: the Normal mode view's layout (List / Tiles) and, for Tiles,
   * the current page of students (roster order) for the teacher's Jitsi
   * iframe (custom.js). The Tiles view's camera rotation covers that page
   * only. Display and receive policy only: nothing is changed for students.
   */
  setTeacherTiles: (state: TeacherTilesState) => void;
};

/** Teacher page -> its own Jitsi iframe (handled by custom.js): Tiles view. */
type TeacherTilesMessage = TeacherTilesState & {
  type: "SL_TEACHER_TILES";
  v: 1;
  /** Own counter; increases on every change. */
  epoch: number;
};

/** Teacher's Jitsi iframe (custom.js) -> page: Previous / Next in the Tiles view. */
type TeacherTilesNavMessage = {
  type: "SL_TEACHER_TILES_NAV";
  v: 1;
  action: TeacherTilesNavAction;
};

export type TeacherTilesNavAction = "previous" | "next";

/**
 * Teacher's Jitsi iframe (custom.js) -> page: View / Tiles page size chosen in
 * the filmstrip settings menu. The page owns both (useTeacherTiles) and answers
 * with a new SL_TEACHER_TILES; the values are validated again there.
 */
type TeacherTilesSettingsMessage = {
  type: "SL_TEACHER_TILES_SETTINGS";
  v: 1;
  layout?: "list" | "tiles";
  pageSize?: number;
};

export type TeacherTilesSettingsChange = {
  layout?: "list" | "tiles";
  pageSize?: number;
};

function isTeacherTilesSettingsMessage(data: unknown): data is TeacherTilesSettingsMessage {
  const message = data as Partial<TeacherTilesSettingsMessage> | null;

  return (
    !!message &&
    message.type === "SL_TEACHER_TILES_SETTINGS" &&
    message.v === 1 &&
    (message.layout === undefined || message.layout === "list" || message.layout === "tiles") &&
    (message.pageSize === undefined || (typeof message.pageSize === "number" && Number.isInteger(message.pageSize))) &&
    (message.layout !== undefined || message.pageSize !== undefined)
  );
}

function isTeacherTilesNavMessage(data: unknown): data is TeacherTilesNavMessage {
  const message = data as Partial<TeacherTilesNavMessage> | null;

  return (
    !!message &&
    message.type === "SL_TEACHER_TILES_NAV" &&
    message.v === 1 &&
    (message.action === "previous" || message.action === "next")
  );
}

/**
 * Where the teacher's normal mode filmstrip sits (custom.js, Phase B). The
 * teacher picks it on the filmstrip itself; custom.js reports the choice
 * (SL_TEACHER_LAYOUT) and this page remembers it (localStorage) and sends it
 * with every teacher view message, so it survives reloads and rejoins.
 */
type TeacherFilmstripPosition = "right" | "left" | "top" | "bottom";

const TEACHER_FILMSTRIP_POSITIONS: TeacherFilmstripPosition[] = [
  "right",
  "left",
  "top",
  "bottom",
];

const TEACHER_FILMSTRIP_POSITION_STORAGE_KEY = "sl-classroom-teacher-filmstrip-position";

function isTeacherFilmstripPosition(value: unknown): value is TeacherFilmstripPosition {
  return TEACHER_FILMSTRIP_POSITIONS.some((position) => position === value);
}

/** `null` when the teacher has never chosen (custom.js defaults to right). */
function readStoredTeacherFilmstripPosition(): TeacherFilmstripPosition | null {
  try {
    const raw = localStorage.getItem(TEACHER_FILMSTRIP_POSITION_STORAGE_KEY);
    return isTeacherFilmstripPosition(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** The filmstrip's auto-hide preference (default off). Only the preference
 * is kept: the filmstrip always starts shown. */
const TEACHER_FILMSTRIP_AUTOHIDE_STORAGE_KEY = "sl-classroom-teacher-filmstrip-autohide";

function readStoredTeacherFilmstripAutoHide(): boolean | null {
  try {
    const raw = localStorage.getItem(TEACHER_FILMSTRIP_AUTOHIDE_STORAGE_KEY);
    return raw === null ? null : raw === "true";
  } catch {
    return null;
  }
}

/** iframe (custom.js) -> teacher page: the teacher changed the filmstrip layout. */
type TeacherLayoutMessage = {
  type: "SL_TEACHER_LAYOUT";
  v: 1;
  position: TeacherFilmstripPosition;
  /** Absent from an older custom.js. */
  autoHide?: boolean;
};

function isTeacherLayoutMessage(data: unknown): data is TeacherLayoutMessage {
  const message = data as Partial<TeacherLayoutMessage> | null;

  return (
    !!message &&
    message.type === "SL_TEACHER_LAYOUT" &&
    message.v === 1 &&
    isTeacherFilmstripPosition(message.position) &&
    (message.autoHide === undefined || typeof message.autoHide === "boolean")
  );
}

/** Message the teacher page posts into the Jitsi iframe (handled by custom.js). */
type ReceiveSetMessage = {
  type: "SL_RECEIVE_SET";
  v: 1;
  /** Increases on every change, so custom.js can ignore a message older than the one it has. */
  epoch: number;
  enabled: boolean;
  participantIds: string[];
};

/** Display-only message for the teacher's monitoring grid (handled by custom.js). */
type MonitorViewMessage = {
  type: "SL_MONITOR_VIEW";
  v: 1;
  /** Own counter, independent of the receive set's epoch. */
  epoch: number;
  enabled: boolean;
  participantIds: string[];
};

/**
 * Student page -> its own Jitsi iframe (handled by custom.js): receive only the
 * teacher's camera and active screen shares, not other students' cameras.
 * Receive-side only: the student's own camera keeps being sent to the teacher.
 */
type StudentViewMessage = {
  type: "SL_STUDENT_VIEW";
  v: 1;
  /** Own counter; the same message is resent as-is, so it never needs to grow. */
  epoch: number;
  enabled: boolean;
};

/**
 * Student page -> its own Jitsi iframe (handled by custom.js): show SL Classroom's
 * own main stage over Jitsi's large video, reusing the already received tracks.
 * Display only.
 */
type StageViewMessage = {
  type: "SL_STAGE_VIEW";
  v: 1;
  /** Own counter; the same message is resent as-is, so it never needs to grow. */
  epoch: number;
  enabled: boolean;
  /**
   * The class teacher's profile for the camera-off placeholder (name,
   * designation, absolute photo URL, Jitsi display name). Absent when the
   * join info has none; an older custom.js ignores it.
   */
  teacher?: StageTeacher | null;
};

type StageTeacher = NonNullable<ReturnType<typeof toStageTeacher>> & {
  /**
   * The photo itself, fetched on this page's origin (fetchStagePhoto), so the
   * iframe shows it without loading it across origins. Absent until fetched
   * or when there is none; custom.js then tries photoUrl, then initials.
   */
  photo?: Blob;
};

/**
 * Phase 4 custom stage for students. Off unless the app is built with
 * NEXT_PUBLIC_SL_CUSTOM_STAGE=true, so it can be tried without changing what
 * students see by default. Jitsi's own large video stays underneath either way.
 */
const SL_CUSTOM_STAGE_ENABLED = process.env.NEXT_PUBLIC_SL_CUSTOM_STAGE === "true";

/** Teacher page -> its own Jitsi iframe (handled by custom.js): normal mode view. */
type TeacherViewMessage = {
  type: "SL_TEACHER_VIEW";
  v: 1;
  /** Own counter; increases on every change. */
  epoch: number;
  enabled: boolean;
  /** Where the filmstrip sits (Phase B). */
  position: TeacherFilmstripPosition;
  /** Whether the filmstrip auto-hides (Phase B, default off). */
  autoHide: boolean;
};

/**
 * Teacher normal mode view (custom stage + custom filmstrip). Off unless the app
 * is built with NEXT_PUBLIC_SL_TEACHER_FILMSTRIP=true; while off, the teacher's
 * iframe is always told `enabled: false`, so Jitsi's own layout stays as it is.
 */
const SL_TEACHER_FILMSTRIP_ENABLED =
  process.env.NEXT_PUBLIC_SL_TEACHER_FILMSTRIP === "true";

/**
 * Page -> its own Jitsi iframe (handled by custom.js): compact toolbar look with
 * a hide/show control, optionally auto-hiding. Presentation only.
 */
type ToolbarViewMessage = {
  type: "SL_TOOLBAR_VIEW";
  v: 1;
  /** Own counter; the same message is resent as-is, so it never needs to grow. */
  epoch: number;
  enabled: boolean;
  autoHide: boolean;
};

/**
 * Toolbar polish, for teachers and students. Off unless the app is built with
 * NEXT_PUBLIC_SL_TOOLBAR_POLISH=true; auto-hide additionally needs
 * NEXT_PUBLIC_SL_TOOLBAR_AUTOHIDE=true. While off, Jitsi's own toolbar is used.
 */
const SL_TOOLBAR_POLISH_ENABLED =
  process.env.NEXT_PUBLIC_SL_TOOLBAR_POLISH === "true";
const SL_TOOLBAR_AUTOHIDE_ENABLED =
  process.env.NEXT_PUBLIC_SL_TOOLBAR_AUTOHIDE === "true";

/**
 * Student page -> its own Jitsi iframe (handled by custom.js): the student's
 * own camera / microphone status indicator, top-right of the classroom.
 * Display only (custom.js reads the local tracks; nothing is muted or sent).
 */
type DeviceStatusViewMessage = {
  type: "SL_DEVICE_STATUS_VIEW";
  v: 1;
  /** Own counter; increases when `fullscreen` changes. */
  epoch: number;
  enabled: boolean;
  /**
   * The page's fullscreen: its "Exit fullscreen" button then covers the
   * iframe's top-right corner, so the indicator moves left of it.
   */
  fullscreen: boolean;
};

/**
 * Student device status indicator. Off unless the app is built with
 * NEXT_PUBLIC_SL_DEVICE_STATUS=true; while off, the student's iframe is told
 * `enabled: false`, so nothing is shown.
 */
const SL_DEVICE_STATUS_ENABLED =
  process.env.NEXT_PUBLIC_SL_DEVICE_STATUS === "true";

/**
 * The SL Classroom Jitsi server. The only origin the receive set is posted to,
 * and the only origin messages from the Jitsi iframe (custom.js) are accepted from.
 */
const SL_JITSI_ORIGIN = "https://meet.slclassroom.live";

/** Which feature asked for the stream (logging only; status is per stream). */
type YouTubeStreamPurpose =
  | "recording"
  | "live";

type UseJitsiProps = {
  
  containerRef: React.RefObject<HTMLDivElement | null>;
  controlsRef: React.RefObject<JitsiControls | null>;
  joinInfo: JoinInfo;
  role: UserRole;
  teacherName: string;
  isJitsiReady: boolean;
  markJoined: () => Promise<void>;
  markLeft: () => Promise<void>;

  onParticipantsChanged?: (
    participants: JitsiParticipant[]
    ) => void;
  onParticipantStatusChanged?: (
    participantId: string,
    status: {
      audioMuted?: boolean;
      videoMuted?: boolean;
    }
  ) => void;

  /** Jitsi "file" recordings only (not used by YouTube Recording / Live). */
  onRecordingStatusChanged?: (
    isRecording: boolean
  ) => void;

  /**
   * The class's YouTube Jibri stream (mode "stream", main room only) started
   * or stopped / failed. YouTube Recording and Live both ride on this one
   * stream; the page applies it to whichever features use it.
   */
  onYouTubeStreamStatusChanged?: (
    status: { on: boolean; error?: string }
  ) => void;

  /** Fired for every chat message (remote arrivals + this device's own sends). */
  onChatMessage?: (message: ChatMessage) => void;

  /** Fired once the local user's Jitsi conference has actually joined. */
  onConferenceJoined?: () => void;

  /**
   * Fired once the local user has genuinely left the conference (clicked
   * "Leave Classroom", or was disconnected) — never for a breakout-room
   * switch. Mirrors the same "not a room switch" grace-period check already
   * used for attendance (`markLeft`), so it fires exactly when that does.
   */
  onLocalUserLeft?: () => void;

  /** Fired whenever the local user's real Jitsi role (moderator/none) changes. */
  onModeratorStatusChanged?: (isModerator: boolean) => void;

  /** Fired whenever the breakout-room list or its participants change. */
  onBreakoutRoomsUpdated?: (rooms: BreakoutRoom[]) => void;

  /** Fired each time this browser enters a room (main or breakout). */
  onRoomChanged?: (room: CurrentRoomInfo) => void;

  /** Tells whether the installed Jitsi build supports the breakout-room commands. */
  onBreakoutSupportChanged?: (supported: boolean) => void;

  /** Teacher only: Previous / Next pressed in the Tiles view inside the iframe. */
  onTeacherTilesNav?: (action: TeacherTilesNavAction) => void;

  /** Teacher only: View / Tiles page size chosen in the iframe's settings menu. */
  onTeacherTilesSettings?: (change: TeacherTilesSettingsChange) => void;

  /** Whether the page shows the meeting fullscreen (students: device status placement). */
  isFullscreen?: boolean;

};

export default function useJitsi({
  containerRef,
  controlsRef,
  joinInfo,
  role,
  teacherName,
  isJitsiReady,
  markJoined,
  markLeft,
  onParticipantsChanged,
  onParticipantStatusChanged,
  onRecordingStatusChanged,
  onYouTubeStreamStatusChanged,
  onChatMessage,
  onConferenceJoined,
  onLocalUserLeft,
  onModeratorStatusChanged,
  onBreakoutRoomsUpdated,
  onRoomChanged,
  onBreakoutSupportChanged,
  onTeacherTilesNav,
  onTeacherTilesSettings,
  isFullscreen = false,

}: UseJitsiProps) {

  const apiRef = useRef<any>(null);

  // Latest callback for the (long-lived) Jitsi listener.
  const onYouTubeStreamStatusChangedRef = useRef(onYouTubeStreamStatusChanged);
  onYouTubeStreamStatusChangedRef.current = onYouTubeStreamStatusChanged;

  // Set from `videoConferenceJoined` so `participantRoleChanged` events can
  // be matched against the local participant.
  const localParticipantIdRef = useRef<string | null>(null);

  // Kept in refs so the (deps: []) imperative handle and the Jitsi listeners
  // always call the latest callback / see the latest local display name.
  const onChatMessageRef = useRef(onChatMessage);
  onChatMessageRef.current = onChatMessage;

  const onConferenceJoinedRef = useRef(onConferenceJoined);
  onConferenceJoinedRef.current = onConferenceJoined;

  const onLocalUserLeftRef = useRef(onLocalUserLeft);
  onLocalUserLeftRef.current = onLocalUserLeft;

  const onModeratorStatusChangedRef = useRef(onModeratorStatusChanged);
  onModeratorStatusChangedRef.current = onModeratorStatusChanged;

  const onTeacherTilesNavRef = useRef(onTeacherTilesNav);
  onTeacherTilesNavRef.current = onTeacherTilesNav;

  const onTeacherTilesSettingsRef = useRef(onTeacherTilesSettings);
  onTeacherTilesSettingsRef.current = onTeacherTilesSettings;

  const onBreakoutRoomsUpdatedRef = useRef(onBreakoutRoomsUpdated);
  onBreakoutRoomsUpdatedRef.current = onBreakoutRoomsUpdated;

  const onRoomChangedRef = useRef(onRoomChanged);
  onRoomChangedRef.current = onRoomChanged;

  const onBreakoutSupportChangedRef = useRef(onBreakoutSupportChanged);
  onBreakoutSupportChangedRef.current = onBreakoutSupportChanged;

  // True while this browser is inside a breakout room instead of the main room.
  const inBreakoutRef = useRef(false);

  // JID of the main MUC: derived up front, replaced by the real one as soon as
  // a rooms update reports it. Returning to the main room needs it.
  const mainRoomJidRef = useRef(mainRoomJidFallback(joinInfo.session));

  const localName =
    role === "teacher"
      ? teacherName
      : joinInfo.student?.name ?? "Student";
  const localNameRef = useRef(localName);
  localNameRef.current = localName;

  const chatSeqRef = useRef(0);
  const nextChatId = () =>
    `chat-${Date.now().toString(36)}-${(chatSeqRef.current += 1)}`;

  // Recording / live streaming belong to the MAIN room. Inside a breakout room the
  // same commands would act on that breakout room instead, so they are blocked.
  const blockedInBreakout = (action: string) => {
    if (!inBreakoutRef.current) {
      return false;
    }

    console.warn(`[breakout] ${action} is unavailable while in a breakout room. Return to the main room first.`);
    return true;
  };

  const roleRef = useRef(role);
  roleRef.current = role;

  const joinInfoRef = useRef(joinInfo);
  joinInfoRef.current = joinInfo;

  // Teacher receive set: the latest one is kept so it can be sent again when
  // custom.js reports it is ready (iframe loaded late / conference replaced).
  const receiveSetEpochRef = useRef(0);
  const receiveSetRef = useRef<ReceiveSetMessage | null>(null);

  const postReceiveSet = () => {
    const message = receiveSetRef.current;

    if (!message || roleRef.current !== "teacher") {
      return;
    }

    const frameWindow = apiRef.current?.getIFrame?.()?.contentWindow as Window | null | undefined;

    if (!frameWindow) {
      // Sent again on SL_RECEIVE_READY once the iframe and custom.js are up.
      return;
    }

    frameWindow.postMessage(message, SL_JITSI_ORIGIN);
  };

  // Teacher monitoring grid: kept and resent on SL_RECEIVE_READY, like the receive set.
  const monitorViewEpochRef = useRef(0);
  const monitorViewRef = useRef<MonitorViewMessage | null>(null);

  const postMonitorView = () => {
    const message = monitorViewRef.current;

    if (!message || roleRef.current !== "teacher") {
      return;
    }

    const frameWindow = apiRef.current?.getIFrame?.()?.contentWindow as Window | null | undefined;

    if (!frameWindow) {
      // Sent again on SL_RECEIVE_READY once the iframe and custom.js are up.
      return;
    }

    frameWindow.postMessage(message, SL_JITSI_ORIGIN);
  };

  // Student view: always on for students. Sent after every conference join and
  // again on SL_RECEIVE_READY (iframe loaded late / conference replaced).
  const studentViewRef = useRef<StudentViewMessage>({
    type: "SL_STUDENT_VIEW",
    v: 1,
    epoch: 1,
    enabled: true,
  });

  const postStudentView = () => {
    if (roleRef.current !== "student") {
      return;
    }

    const frameWindow = apiRef.current?.getIFrame?.()?.contentWindow as Window | null | undefined;

    if (!frameWindow) {
      // Sent again on SL_RECEIVE_READY once the iframe and custom.js are up.
      return;
    }

    frameWindow.postMessage(studentViewRef.current, SL_JITSI_ORIGIN);
  };

  // Custom stage: students only, on/off by SL_CUSTOM_STAGE_ENABLED. Sent (also
  // when off, so custom.js is told explicitly) after every conference join and
  // again on SL_RECEIVE_READY, like the student view.
  const stageViewRef = useRef<StageViewMessage>({
    type: "SL_STAGE_VIEW",
    v: 1,
    epoch: 1,
    enabled: SL_CUSTOM_STAGE_ENABLED,
  });

  const postStageView = () => {
    if (roleRef.current !== "student") {
      return;
    }

    const frameWindow = apiRef.current?.getIFrame?.()?.contentWindow as Window | null | undefined;

    if (!frameWindow) {
      // Sent again on SL_RECEIVE_READY once the iframe and custom.js are up.
      return;
    }

    // The teacher profile is added here (client only: it needs the page's
    // origin to make the stored photo path absolute for the iframe).
    stageViewRef.current.teacher ??= toStageTeacher(joinInfoRef.current, window.location.origin);

    const teacher = stageViewRef.current.teacher;
    const photo = stagePhotoRef.current;

    frameWindow.postMessage(
      teacher && photo ? { ...stageViewRef.current, teacher: { ...teacher, photo } } : stageViewRef.current,
      SL_JITSI_ORIGIN
    );
  };

  // The teacher's photo for the camera-off card, fetched once on this page's
  // own origin and resent with the stage view when it arrives (students with
  // the custom stage only). Fails quietly: the card then shows initials.
  const stagePhotoRef = useRef<Blob | null>(null);
  const stagePhotoUrl = role === "student" && SL_CUSTOM_STAGE_ENABLED
    ? joinInfo.teacherProfile?.photoUrl ?? null
    : null;

  useEffect(() => {
    if (!stagePhotoUrl) {
      return;
    }

    const controller = new AbortController();

    void fetchStagePhoto(stagePhotoUrl, { signal: controller.signal }).then(photo => {
      if (!photo || controller.signal.aborted) {
        return;
      }

      stagePhotoRef.current = photo;
      postStageView();
    });

    return () => controller.abort();
    // postStageView reads refs only, so the effect only follows the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagePhotoUrl]);

  // Toolbar polish: every role. Sent (also when off, so custom.js is told
  // explicitly) after every conference join and again on SL_RECEIVE_READY.
  const toolbarViewRef = useRef<ToolbarViewMessage>({
    type: "SL_TOOLBAR_VIEW",
    v: 1,
    epoch: 1,
    enabled: SL_TOOLBAR_POLISH_ENABLED,
    autoHide: SL_TOOLBAR_POLISH_ENABLED && SL_TOOLBAR_AUTOHIDE_ENABLED,
  });

  const postToolbarView = () => {
    const frameWindow = apiRef.current?.getIFrame?.()?.contentWindow as Window | null | undefined;

    if (!frameWindow) {
      // Sent again on SL_RECEIVE_READY once the iframe and custom.js are up.
      return;
    }

    frameWindow.postMessage(toolbarViewRef.current, SL_JITSI_ORIGIN);
  };

  // Student device status indicator: students only, on/off by
  // SL_DEVICE_STATUS_ENABLED. Sent (also when off, so custom.js is told
  // explicitly) after every conference join, again on SL_RECEIVE_READY, and
  // whenever the page's fullscreen changes (a new epoch then).
  const deviceStatusViewRef = useRef<DeviceStatusViewMessage>({
    type: "SL_DEVICE_STATUS_VIEW",
    v: 1,
    epoch: 1,
    enabled: SL_DEVICE_STATUS_ENABLED,
    fullscreen: isFullscreen,
  });

  const postDeviceStatusView = () => {
    if (roleRef.current !== "student") {
      return;
    }

    const frameWindow = apiRef.current?.getIFrame?.()?.contentWindow as Window | null | undefined;

    if (!frameWindow) {
      // Sent again on SL_RECEIVE_READY once the iframe and custom.js are up.
      return;
    }

    frameWindow.postMessage(deviceStatusViewRef.current, SL_JITSI_ORIGIN);
  };

  useEffect(() => {
    const current = deviceStatusViewRef.current;

    if (current.fullscreen === isFullscreen) {
      return;
    }

    deviceStatusViewRef.current = {
      ...current,
      epoch: current.epoch + 1,
      fullscreen: isFullscreen,
    };
    postDeviceStatusView();
    // postDeviceStatusView reads refs only, so the effect only follows the flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFullscreen]);

  // Teacher normal mode view: kept and resent on SL_RECEIVE_READY, like the
  // receive set and the monitoring grid.
  const teacherViewEpochRef = useRef(0);
  const teacherViewRef = useRef<TeacherViewMessage | null>(null);
  const teacherFilmstripPositionRef = useRef<TeacherFilmstripPosition>("right");
  const teacherFilmstripAutoHideRef = useRef(false);

  // The teacher's saved filmstrip position and auto-hide preference, read
  // once on mount (before any teacher view message is built: that only
  // happens after the join).
  useEffect(() => {
    const stored = readStoredTeacherFilmstripPosition();

    if (stored) {
      teacherFilmstripPositionRef.current = stored;
    }

    teacherFilmstripAutoHideRef.current = readStoredTeacherFilmstripAutoHide() ?? false;
  }, []);

  const postTeacherView = () => {
    const message = teacherViewRef.current;

    if (!message || roleRef.current !== "teacher") {
      return;
    }

    const frameWindow = apiRef.current?.getIFrame?.()?.contentWindow as Window | null | undefined;

    if (!frameWindow) {
      // Sent again on SL_RECEIVE_READY once the iframe and custom.js are up.
      return;
    }

    frameWindow.postMessage(message, SL_JITSI_ORIGIN);
  };

  // Teacher Tiles view: kept and resent on SL_RECEIVE_READY, like the teacher
  // view. Only sent once the page has set it (after the join).
  const teacherTilesEpochRef = useRef(0);
  const teacherTilesRef = useRef<TeacherTilesMessage | null>(null);

  const postTeacherTiles = () => {
    const message = teacherTilesRef.current;

    if (!message || roleRef.current !== "teacher") {
      return;
    }

    const frameWindow = apiRef.current?.getIFrame?.()?.contentWindow as Window | null | undefined;

    if (!frameWindow) {
      // Sent again on SL_RECEIVE_READY once the iframe and custom.js are up.
      return;
    }

    frameWindow.postMessage(message, SL_JITSI_ORIGIN);
  };

  useImperativeHandle(
    controlsRef,
    () => ({
      ...createBreakoutControls(
        () => apiRef.current,
        () => mainRoomJidRef.current
      ),

      startRecording: () => {
        if (!apiRef.current) {
          console.warn(
            "Jitsi API is not ready"
          );
          return;
        }

        if (blockedInBreakout("Recording")) {
          return;
        }

        console.log(
          "🎥 Starting Jitsi recording..."
        );

        apiRef.current.executeCommand(
          "startRecording",
          {
            mode: "file",
          }
        );
      },

      stopRecording: () => {
        if (!apiRef.current) {
          console.warn(
            "Jitsi API is not ready"
          );
          return;
        }

        if (blockedInBreakout("Stopping the recording")) {
          return;
        }

        console.log(
          "🛑 Stopping Jitsi recording..."
        );

        apiRef.current.executeCommand(
          "stopRecording",
          "file"
        );
      },

      startYouTubeLive: (  streamKey,
            broadcastId,purpose) => {
        if (!apiRef.current) {
          console.warn(
            "Jitsi API is not ready"
          );
          return;
        }

        if (blockedInBreakout("YouTube Live")) {
          return;
        }

        console.log(
          "🔴 Starting the YouTube stream for:",
          purpose
        );

        apiRef.current.executeCommand(
          "startRecording",
          {
            mode: "stream",

            youtubeStreamKey:
              streamKey,

            youtubeBroadcastID:
              broadcastId,
          }
        );
      },

      stopYouTubeLive: () => {
        if (!apiRef.current) {
          console.warn(
            "Jitsi API is not ready"
          );
          return;
        }

        if (blockedInBreakout("Stopping YouTube Live")) {
          return;
        }

        console.log(
          "🛑 Stopping YouTube Live..."
        );

        apiRef.current.executeCommand(
          "stopRecording",
          "stream"
        );
      },

      muteEveryone: () => {
        if (!apiRef.current) {
          console.warn("Jitsi API is not ready");
          return;
        }

        console.log("🔇 Muting everyone (audio)...");

        apiRef.current.executeCommand("muteEveryone", "audio");
      },

      setParticipantAudioMuted: (participantId, muted) => {
        if (!apiRef.current) {
          console.warn("Jitsi API is not ready");
          return;
        }

        console.log(
          muted ? "🔇 Muting participant" : "🔈 Asking participant to unmute",
          participantId
        );

        if (muted) {
          // Moderator-only: mutes just this one remote participant's mic.
          apiRef.current.executeCommand(
            "muteRemoteParticipant",
            participantId,
            "audio"
          );
        } else {
          // Jitsi does not allow force-unmute; this sends an unmute request.
          apiRef.current.executeCommand("askToUnmute", participantId);
        }
      },

      sendChatMessage: (message) => {
        const text = message.trim();
        if (!text || !apiRef.current) {
          return;
        }

        // Empty `to` + ignorePrivacy = send to everyone in the meeting. The
        // `outgoingMessage` listener below echoes it into our panel — it also
        // catches messages sent through Jitsi's own chat button, so both entry
        // points stay in sync.
        apiRef.current.executeCommand("sendChatMessage", text, "", true);
      },

      setVideoQuality: (heightPx) => {
        if (!apiRef.current) {
          console.warn("Jitsi API is not ready");
          return;
        }

        console.log("🎚️ Setting video quality:", heightPx);

        apiRef.current.executeCommand("setVideoQuality", heightPx);
      },

      setNoiseSuppression: (enabled) => {
        if (!apiRef.current) {
          console.warn("Jitsi API is not ready");
          return;
        }

        console.log("🔇 Setting noise suppression:", enabled);

        apiRef.current.executeCommand("setNoiseSuppressionEnabled", { enabled });
      },

      endConference: () => {
        if (!apiRef.current) {
          console.warn("Jitsi API is not ready");
          return;
        }

        console.log("🛑 Ending the conference for everyone...");

        apiRef.current.executeCommand("endConference");
      },

      setReceiveSet: (participantIds) => {
        if (roleRef.current !== "teacher") {
          return;
        }

        receiveSetEpochRef.current += 1;
        receiveSetRef.current = {
          type: "SL_RECEIVE_SET",
          v: 1,
          epoch: receiveSetEpochRef.current,
          enabled: participantIds !== null,
          participantIds: participantIds ? Array.from(new Set(participantIds)) : [],
        };

        postReceiveSet();
      },

      setMonitorView: (participantIds) => {
        if (roleRef.current !== "teacher") {
          return;
        }

        monitorViewEpochRef.current += 1;
        monitorViewRef.current = {
          type: "SL_MONITOR_VIEW",
          v: 1,
          epoch: monitorViewEpochRef.current,
          enabled: participantIds !== null,
          participantIds: participantIds ? Array.from(new Set(participantIds)) : [],
        };

        postMonitorView();
      },

      setTeacherView: (enabled) => {
        if (roleRef.current !== "teacher") {
          return;
        }

        teacherViewEpochRef.current += 1;
        teacherViewRef.current = {
          type: "SL_TEACHER_VIEW",
          v: 1,
          epoch: teacherViewEpochRef.current,
          enabled: enabled && SL_TEACHER_FILMSTRIP_ENABLED,
          position: teacherFilmstripPositionRef.current,
          autoHide: teacherFilmstripAutoHideRef.current,
        };

        postTeacherView();
      },

      setTeacherTiles: (state) => {
        if (roleRef.current !== "teacher") {
          return;
        }

        teacherTilesEpochRef.current += 1;
        teacherTilesRef.current = {
          type: "SL_TEACHER_TILES",
          v: 1,
          epoch: teacherTilesEpochRef.current,
          layout: state.layout,
          participantIds: Array.from(new Set(state.participantIds)),
          page: state.page,
          pageCount: state.pageCount,
          rangeStart: state.rangeStart,
          rangeEnd: state.rangeEnd,
          total: state.total,
          pageSize: state.pageSize,
        };

        postTeacherTiles();
      },
    }),
    []
  );

  /*
   * ============================================================
   * 1. SL CLASSROOM FULLSCREEN
   * ============================================================
   */

  useEffect(() => {

    const handleClassroomMode = async (
      event: MessageEvent
    ) => {

      // Only messages from our own Jitsi iframe (custom.js) are trusted: right
      // origin, and sent by that iframe's window rather than any other frame.
      const frameWindow = apiRef.current?.getIFrame?.()?.contentWindow;

      if (
        event.origin !== SL_JITSI_ORIGIN ||
        !frameWindow ||
        event.source !== frameWindow
      ) {
        return;
      }

      // custom.js is (re)ready inside the iframe: send the current state again,
      // since anything sent earlier may have been missed. Teacher: receive set,
      // then the monitoring-grid view, then the normal mode teacher view and
      // its Tiles view page.
      // Student: the student view, then the custom stage view and the device
      // status view. Each post checks the role itself, so only the matching
      // ones are sent. Both: the toolbar view.
      if (event.data?.type === "SL_RECEIVE_READY") {
        postReceiveSet();
        postMonitorView();
        postStudentView();
        postStageView();
        postDeviceStatusView();
        postTeacherView();
        postTeacherTiles();
        postToolbarView();
        return;
      }

      // Teacher Tiles view: Previous / Next pressed inside the iframe. The
      // page owns the paging; it answers with a new SL_TEACHER_TILES.
      if (isTeacherTilesNavMessage(event.data)) {
        if (roleRef.current === "teacher") {
          onTeacherTilesNavRef.current?.(event.data.action);
        }

        return;
      }

      // Teacher Tiles view: View / page size from the iframe's settings menu.
      if (isTeacherTilesSettingsMessage(event.data)) {
        if (roleRef.current === "teacher") {
          onTeacherTilesSettingsRef.current?.({
            layout: event.data.layout,
            pageSize: event.data.pageSize,
          });
        }

        return;
      }

      // The teacher changed the filmstrip layout on the filmstrip itself
      // (position, auto-hide): remember it (localStorage) and keep it in the
      // teacher view message, so a resend or the next join restores it. The
      // iframe already shows it, so nothing is posted back.
      if (isTeacherLayoutMessage(event.data)) {
        if (roleRef.current !== "teacher") {
          return;
        }

        const { position } = event.data;
        const autoHide = event.data.autoHide ?? teacherFilmstripAutoHideRef.current;

        teacherFilmstripPositionRef.current = position;
        teacherFilmstripAutoHideRef.current = autoHide;

        if (teacherViewRef.current) {
          teacherViewRef.current = { ...teacherViewRef.current, position, autoHide };
        }

        try {
          localStorage.setItem(TEACHER_FILMSTRIP_POSITION_STORAGE_KEY, position);
          localStorage.setItem(TEACHER_FILMSTRIP_AUTOHIDE_STORAGE_KEY, String(autoHide));
        } catch {
          /* private mode — the choice just won't persist */
        }

        return;
      }

      if (event.data?.type !== "SL_CLASSROOM_MODE") {
        return;
      }

      console.log("SL Classroom Mode clicked");

      try {

        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen();
        }

      } catch (error) {
        console.error(
          "Unable to enter fullscreen:",
          error
        );
      }
    };

    window.addEventListener(
      "message",
      handleClassroomMode
    );

    return () => {
      window.removeEventListener(
        "message",
        handleClassroomMode
      );
    };

  }, []);



  /*
   * ============================================================
   * 2. JITSI INITIALIZATION
   * ============================================================
   */

  useEffect(() => {

    if (
      !containerRef.current ||
      !isJitsiReady ||
      !window.JitsiMeetExternalAPI
    ) {
      return;
    }

    // Prevent creating Jitsi more than once
    if (containerRef.current.childElementCount > 0) {
      return;
    }

    const toolbarButtons =
      role === "teacher"
        ? teacherToolbar
        : studentToolbar;


    /*
     * ------------------------------------------------------------
     * Create Jitsi
     * ------------------------------------------------------------
     */

    const api =
      new window.JitsiMeetExternalAPI(
        joinInfo.session.jitsiDomain,
        {
          roomName:
            joinInfo.session.roomName,

          parentNode:
            containerRef.current,

          userInfo: {
            displayName:
              role === "teacher"
                ? teacherName
                : joinInfo.student?.name ?? "Student",
          },

          ...(joinInfo.token && {
            jwt: joinInfo.token,
          }),

          configOverwrite: {

            reducedUIEnabled: false,

            reducedUImainToolbarButtons: [
                "microphone",
                "camera",
                "desktop",
                "fullscreen",
                "hangup",
                "settings",
                "videoquality",
                "select-background",
                "security",
            ],

            prejoinPageEnabled: false,

            prejoinConfig: {
              enabled: false,
            },

            startWithAudioMuted: true,
            startWithVideoMuted: true,

            resolution: 720,

            constraints: {
              video: {
                height: {
                  ideal: 720,
                  max: 1080,
                  min: 240,
                },
              },
            },

            disableSimulcast: false,
            disableTileView: true,

            channelLastN: 5,

            enableWelcomePage: false,

            enableNoAudioDetection: false,
            enableNoisyMicDetection: false,

            disableInviteFunctions: true,

            hideConferenceSubject: true,

            disableReactions: true,

            toolbarConfig: {
              alwaysVisible: true,
            },

            p2p: {
              enabled: false,
            },

            // Verified against this exact deployment's own config.js (both keys
            // exist there, documented but commented out/default-off). Students
            // get no self-view tile and no participant filmstrip; the teacher
            // keeps both. Display only: hiding the self-view does not stop the
            // student's camera from being sent (the teacher monitors it). What
            // a student actually receives is limited by the student view
            // (SL_STUDENT_VIEW) in custom.js, not by hiding the filmstrip.
            disableSelfView: role === "student",

            filmstrip: {
              disabled: role === "student",
            },
          },

          interfaceConfigOverwrite: {

            TOOLBAR_BUTTONS:
              toolbarButtons,

            DISABLE_TILE_VIEW: true,

            // Jitsi's blurred large-video background redraws the large video
            // onto a full-screen canvas every 200 ms under a CSS blur (Chrome /
            // Edge). It is never seen under SL Classroom's own stage, so it is
            // pure CPU/GPU cost. Rendering only: media is unchanged.
            DISABLE_VIDEO_BACKGROUND: true,

            SHOW_JITSI_WATERMARK: false,
            SHOW_WATERMARK_FOR_GUESTS: false,
            SHOW_BRAND_WATERMARK: false,

            BRAND_WATERMARK_LINK: "",

            MOBILE_APP_PROMO: false,

            DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
          },
        }
      );

      apiRef.current = api;




    /*
     * ============================================================
     * PARTICIPANTS
     * ============================================================
     */

    // const updateParticipants = () => {

    //   const participants =
    //     api.getParticipantsInfo();

    //     console.log(participants);

    //   const mappedParticipants:
    //     JitsiParticipant[] =
    //     participants.map((participant) => ({

    //       participantId:
    //         participant.participantId,

    //       displayName:
    //         participant.displayName,

    //       avatarURL:
    //         undefined,

    //       role:
    //         participant.displayName === teacherName
    //           ? "moderator"
    //           : "participant",

    //       status: {

    //         audioMuted: false,

    //         videoMuted: false,

    //         raisedHand: false,

    //         isSpeaking: false,

    //         connectionQuality:
    //           "excellent",
    //       },
    //     }));

    //   onParticipantsChanged?.(
    //     mappedParticipants
    //   );

    //   console.log(mappedParticipants);

    // };

    /*
     * ============================================================
     * STUDENT -> PARTICIPANT ID REGISTRATION
     * ============================================================
     * Lets the teacher address this student by application student ID
     * instead of by display name. Only the ID is sent; camera and mic are
     * not touched.
     */

    const registerParticipantId = async (participantId: string) => {
      const url = `/api/sessions/${joinInfo.session.id}/participant-map`;

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ participantId }),
          });

          if (response.ok) {
            return;
          }

          // 4xx (not enrolled, conflict, bad ID) will not get better on retry.
          if (response.status < 500) {
            console.warn(
              "Participant ID registration rejected:",
              response.status,
              await response.text()
            );
            return;
          }
        } catch (error) {
          console.warn("Participant ID registration failed:", error);
        }

        if (attempt === 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    };

    const updateParticipants = () => {

        const participants = api.getParticipantsInfo();

        console.log(
            "🟡 JITSI updateParticipants() CALLED"
        );

        console.log(
            "🟡 JITSI PARTICIPANTS:",
            participants
        );

        console.log(
            "🟡 JITSI COUNT:",
            participants.length
        );

        const mappedParticipants: JitsiParticipant[] =
            participants.map((participant) => ({
            participantId: participant.participantId,
            displayName: participant.displayName,
            avatarURL: undefined,

            role:
                participant.displayName === teacherName
                ? "moderator"
                : "participant",

            status: {
                audioMuted: true,
                videoMuted: true,
                raisedHand: false,
                isSpeaking: false,
                connectionQuality: "excellent",
            },
            }));

        console.log(
            "🟡 MAPPED PARTICIPANTS:",
            mappedParticipants
        );

        onParticipantsChanged?.(mappedParticipants);
    };


    /*
     * ============================================================
     * PARTICIPANT JOINED
     * ============================================================
     */

    const handleParticipantJoined = (
      event: unknown
    ) => {

      const participant =
        event as {
          id?: string;
          displayName?: string;
        };

        console.log(participant);

      if (!participant.id) {
        return;
      }

      updateParticipants();
    };


    /*
     * ============================================================
     * PARTICIPANT LEFT
     * ============================================================
     */

    const handleParticipantLeft = () => {

      updateParticipants();

    };


  



    /*
     * ============================================================
     * CONFERENCE JOINED
     * ============================================================
     */

    const handleJoined = (event: unknown) => {

      console.log(
        "Jitsi conference joined"
      );

      const data = event as
        | { id?: string; roomName?: string; breakoutRoom?: boolean }
        | undefined;

      // Any "joined" means the earlier "left" (if there was one) was a room switch.
      cancelPendingLeave();

      if (data?.id) {
        localParticipantIdRef.current = data.id;

        // Every join (first join, reconnect, breakout-room switch) can come with
        // a new participant ID, so the student re-registers it each time. The
        // server takes the student from the login session, not from this body.
        if (role === "student") {
          void registerParticipantId(data.id);
        }
      }

      // Student view, custom stage view, device status view and toolbar view
      // on every join (first join, reconnect, breakout switch).
      postStudentView();
      postStageView();
      postDeviceStatusView();
      postToolbarView();

      const enteringBreakout = data?.breakoutRoom === true;
      const returningFromBreakout = !enteringBreakout && inBreakoutRef.current;

      inBreakoutRef.current = enteringBreakout;

      onRoomChangedRef.current?.({
        roomName: data?.roomName ?? "",
        isBreakoutRoom: enteringBreakout,
      });

      updateParticipants();

      // Populate the room list for people who joined after the rooms were created.
      void createBreakoutControls(
        () => api,
        () => mainRoomJidRef.current
      )
        .refreshBreakoutRooms()
        .then((rooms) => {
          if (rooms.length > 0) {
            handleBreakoutRoomsList(rooms);
          }
        });

      // Moving into / back out of a breakout room is an internal room switch, not
      // the student (re)joining the class, so it must not create attendance records.
      if (enteringBreakout || returningFromBreakout) {
        return;
      }

      // A new visit only when the previous one was confirmed left: a "joined"
      // that cancelled a pending leave above (a brief reconnect) continues
      // the open visit, and useAttendance sends nothing for it.
      void markJoined();

      onConferenceJoinedRef.current?.();
    };


    /*
     * ============================================================
     * CONFERENCE LEFT
     * ============================================================
     */

    let pendingLeaveTimer: ReturnType<typeof setTimeout> | null = null;

    const cancelPendingLeave = () => {
      if (pendingLeaveTimer) {
        clearTimeout(pendingLeaveTimer);
        pendingLeaveTimer = null;
      }
    };

    const handleLeftConference = () => {

      // Breakout switches also fire "left". Wait briefly for the matching "joined"
      // before recording that the student left the class.
      cancelPendingLeave();

      pendingLeaveTimer = setTimeout(() => {
        pendingLeaveTimer = null;
        inBreakoutRef.current = false;
        void markLeft();
        onLocalUserLeftRef.current?.();
      }, ROOM_SWITCH_GRACE_MS);
    };

    /*
     * ============================================================
     * BREAKOUT ROOMS
     * ============================================================
     */

    const handleBreakoutRoomsList = (rooms: BreakoutRoom[]) => {
      const main = rooms.find((room) => room.isMainRoom);

      if (main?.jid) {
        mainRoomJidRef.current = main.jid;
      }

      onBreakoutRoomsUpdatedRef.current?.(rooms);
    };

    const handleBreakoutRoomsUpdated = (event: unknown) => {
      handleBreakoutRoomsList(normalizeBreakoutRooms(event));
    };

    onBreakoutSupportChangedRef.current?.(isBreakoutSupported(api));

    /*
     * ============================================================
     * PARTICIPANT ROLE CHANGED
     * ============================================================
     * Jitsi's real moderator status — used to gate moderator-only actions
     * (recording / going live) until it's actually confirmed, instead of
     * guessing from the display name.
     */

    const handleParticipantRoleChanged = (event: unknown) => {
      const data = event as
        | { id?: string; role?: string }
        | undefined;

      if (!data?.id || data.id !== localParticipantIdRef.current) {
        return;
      }

      onModeratorStatusChangedRef.current?.(
        data.role === "moderator"
      );
    };

    const handleParticipantMuted = (event: unknown) => {
        const data = event as {
            id?: string;
            isMuted?: boolean;
            mediaType?: string;
        };

        console.log("🔊 PARTICIPANT MUTED EVENT:", data);

        if (!data.id) {
            return;
        }

        if (data.mediaType === "audio") {
            onParticipantStatusChanged?.(
            data.id,
            {
                audioMuted: data.isMuted ?? false,
            }
            );
        }

        if (data.mediaType === "video") {
            onParticipantStatusChanged?.(
            data.id,
            {
                videoMuted: data.isMuted ?? false,
            }
            );
        }
    };

    /*
     * ============================================================
     * CHAT — Jitsi's own realtime chat, mirrored into our UI.
     * `incomingMessage` fires only for messages from other participants;
     * our own sends are echoed locally by `sendChatMessage` above.
     * ============================================================
     */
    const handleIncomingMessage = (event: unknown) => {
      const data = event as {
        from?: string;
        nick?: string;
        message?: string;
        privateMessage?: boolean;
        stamp?: string;
      };

      console.log("💬 INCOMING CHAT MESSAGE:", data);

      if (!data.message) {
        return;
      }

      onChatMessageRef.current?.({
        id: nextChatId(),
        author: data.nick?.trim() || "Participant",
        body: data.message,
        at: data.stamp ?? new Date().toISOString(),
        self: false,
      });
    };

    // Fires for every message *this* device sends — through our chat panel's
    // `sendChatMessage` control or Jitsi's own built-in chat button — so both
    // entry points land in the same panel without double-counting.
    const handleOutgoingMessage = (event: unknown) => {
      const data = event as { message?: string; privateMessage?: boolean };

      console.log("💬 OUTGOING CHAT MESSAGE:", data);

      if (!data.message) {
        return;
      }

      onChatMessageRef.current?.({
        id: nextChatId(),
        author: localNameRef.current,
        body: data.message,
        at: new Date().toISOString(),
        self: true,
      });
    };

    const handleRecordingStatusChanged = (
      event: unknown
    ) => {
      const data = event as {
        on?: boolean;
        mode?: string;
        transcription?: boolean;
        error?: string;
      };

      console.log(
        "🎥 JITSI RECORDING STATUS:",
        data
      );

      console.log(
        "🎥 JITSI RECORDING STATUS JSON:",
        JSON.stringify(data, null, 2)
      );

      // Recording and live streaming run in the MAIN room. While the teacher is in a
      // breakout room, status events describe that room, not the class stream, so
      // they must not change the classroom's recording / live UI.
      if (inBreakoutRef.current) {
        console.log("[breakout] Ignoring recording status while in a breakout room.");
        return;
      }

      const isOn = data.on ?? false;

      /*
     * YouTube Recording and YouTube Live both use Jitsi mode "stream": ONE
     * Jibri stream for the conference. Its status is reported as such; the
     * page applies it to every feature riding on it (never "whichever
     * feature started it last").
     */
      const streamStatus = toYouTubeStreamStatus(event, {
        inBreakout: inBreakoutRef.current,
      });

      if (streamStatus) {
          onYouTubeStreamStatusChangedRef.current?.(streamStatus);

          return;
      }

      /*
      * File mode is a separate Jitsi recording
      * feature. Your YouTube flow does not use it.
      */
      if (data.mode === "file") {

          console.log(
              "📁 Jitsi file recording status:",
              isOn
          );

          onRecordingStatusChanged?.(
              isOn
          );

          return;
      }
    };

    /*
     * ============================================================
     * REGISTER ONLY REQUIRED LISTENERS
     * ============================================================
     */

    api.addListener(
      "videoConferenceJoined",
      handleJoined
    );

    api.addListener(
      "videoConferenceLeft",
      handleLeftConference
    );

    api.addListener(
      "participantRoleChanged",
      handleParticipantRoleChanged
    );

    api.addListener(
      "participantJoined",
      handleParticipantJoined
    );

    api.addListener(
      "participantLeft",
      handleParticipantLeft
    );

    api.addListener(
      "participantMuted",
      handleParticipantMuted
    );

    api.addListener(
      "recordingStatusChanged",
      handleRecordingStatusChanged
    );

    api.addListener(
      "incomingMessage",
      handleIncomingMessage
    );

    api.addListener(
      "outgoingMessage",
      handleOutgoingMessage
    );

    api.addListener(
      "breakoutRoomsUpdated",
      handleBreakoutRoomsUpdated
    );

    /*
     * ============================================================
     * BROWSER CLOSE / REFRESH
     * ============================================================
     */

    // A refresh / tab close ends the visit (sent with keepalive by
    // useAttendance; one request per visit however many of these fire).
    // pagehide also covers mobile Safari, which often skips beforeunload.
    const handleBeforeUnload = () => {
      void markLeft();
    };

    window.addEventListener(
      "beforeunload",
      handleBeforeUnload
    );

    window.addEventListener(
      "pagehide",
      handleBeforeUnload
    );


    /*
     * ============================================================
     * CLEANUP
     * ============================================================
     */

    return () => {

      window.removeEventListener(
        "beforeunload",
        handleBeforeUnload
      );

      window.removeEventListener(
        "pagehide",
        handleBeforeUnload
      );

      api.removeListener(
        "videoConferenceJoined",
        handleJoined
      );

      api.removeListener(
        "videoConferenceLeft",
        handleLeftConference
      );

      api.removeListener(
        "participantRoleChanged",
        handleParticipantRoleChanged
      );

      api.removeListener(
        "participantJoined",
        handleParticipantJoined
      );

      api.removeListener(
        "participantLeft",
        handleParticipantLeft
      );

      api.removeListener(
        "participantMuted",
        handleParticipantMuted
      );

      api.removeListener(
        "recordingStatusChanged",
        handleRecordingStatusChanged
      );

      api.removeListener(
        "incomingMessage",
        handleIncomingMessage
      );

      api.removeListener(
        "outgoingMessage",
        handleOutgoingMessage
      );

      api.removeListener(
        "breakoutRoomsUpdated",
        handleBreakoutRoomsUpdated
      );

      cancelPendingLeave();
      inBreakoutRef.current = false;

      api.dispose();

      apiRef.current = null;

      void markLeft();
    };

  }, [
    containerRef,
    isJitsiReady,
    joinInfo,
    role,
    teacherName,
    markJoined,
    markLeft,
    onParticipantsChanged,
  ]);

  return null;
}