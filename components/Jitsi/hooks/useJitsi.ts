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
};

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

  onRecordingStatusChanged?: (
    isRecording: boolean
  ) => void;

  onLiveStatusChanged?: (
    isLive: boolean
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
  onLiveStatusChanged,
  onChatMessage,
  onConferenceJoined,
  onLocalUserLeft,
  onModeratorStatusChanged,
  onBreakoutRoomsUpdated,
  onRoomChanged,
  onBreakoutSupportChanged,

}: UseJitsiProps) {

  const apiRef = useRef<any>(null);

  const youtubeStreamPurposeRef =
  useRef<YouTubeStreamPurpose | null>(null);

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

        youtubeStreamPurposeRef.current = purpose;

        console.log(
          "🔴 Starting YouTube Live..."
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

            channelLastN: 1,

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
              enabled: true,
            },

            // Verified against this exact deployment's own config.js (both keys
            // exist there, documented but commented out/default-off) — hides the
            // local self-view tile and the participant filmstrip for both roles,
            // set once at conference init rather than toggled after join.
            disableSelfView: false,

            filmstrip: {
              disabled: false,
            },
          },

          interfaceConfigOverwrite: {

            TOOLBAR_BUTTONS:
              toolbarButtons,

            DISABLE_TILE_VIEW: true,

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
      }

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
     * Our YouTube Recording and YouTube Live
     * both use Jitsi mode: "stream".
     *
     * The purpose ref tells us which one
     * started this stream.
     */
      if (data.mode === "stream") {

          const purpose =
              youtubeStreamPurposeRef.current;

          console.log(
              "🎥 YOUTUBE STREAM PURPOSE:",
              purpose
          );

          if (purpose === "recording") {

              console.log(
                  "⏺ YouTube Recording status:",
                  isOn
              );

              onRecordingStatusChanged?.(
                  isOn
              );

              return;
          }

          if (purpose === "live") {

              console.log(
                  "🔴 YouTube Live status:",
                  isOn
              );

              onLiveStatusChanged?.(
                  isOn
              );

              return;
          }

          console.warn(
              "⚠️ YouTube stream status received without a purpose."
          );

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

    const handleBeforeUnload = () => {
      void markLeft();
    };

    window.addEventListener(
      "beforeunload",
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