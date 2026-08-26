"use client";

import {
  useEffect,
  useRef,
  useImperativeHandle,
} from "react";

import type {
  JitsiParticipant,
  JoinInfo,
  UserRole,
} from "../types";

import {
  studentToolbar,
  teacherToolbar,
} from "../constants/toolbar";

export type JitsiControls = {
  startRecording: () => void;
  stopRecording: () => void;
  startYouTubeLive: (
    streamKey: string,
    broadcastId: string,
    purpose:YouTubeStreamPurpose
  ) => void;
  stopYouTubeLive: () => void;
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
  onLiveStatusChanged
  
}: UseJitsiProps) {

  const apiRef = useRef<any>(null);

  const youtubeStreamPurposeRef =
  useRef<YouTubeStreamPurpose | null>(null);

  useImperativeHandle(
    controlsRef,
    () => ({
      startRecording: () => {
        if (!apiRef.current) {
          console.warn(
            "Jitsi API is not ready"
          );
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

        console.log(
          "🛑 Stopping YouTube Live..."
        );

        apiRef.current.executeCommand(
          "stopRecording",
          "stream"
        );
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

            prejoinPageEnabled: false,

            prejoinConfig: {
              enabled: false,
            },

            startWithAudioMuted: true,
            startWithVideoMuted: true,

            resolution: 360,

            constraints: {
              video: {
                height: {
                  ideal: 360,
                  max: 360,
                  min: 180,
                },
              },
            },

            disableSimulcast: true,
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

    const handleJoined = () => {

      console.log(
        "Jitsi conference joined"
      );

      updateParticipants();

      void markJoined();
    };


    /*
     * ============================================================
     * CONFERENCE LEFT
     * ============================================================
     */

    const handleLeftConference = () => {

      void markLeft();
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