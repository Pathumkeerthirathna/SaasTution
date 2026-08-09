"use client";

import {
  Dispatch,
  SetStateAction,
  useEffect,
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

type UseJitsiProps = {
  containerRef: React.RefObject<HTMLDivElement | null>;
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
};

export default function useJitsi({
  containerRef,
  joinInfo,
  role,
  teacherName,
  isJitsiReady,
  markJoined,
  markLeft,
  onParticipantsChanged,
  onParticipantStatusChanged,
  
}: UseJitsiProps) {

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
      
      api.dispose();

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