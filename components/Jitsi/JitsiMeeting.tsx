

"use client";

import {
  forwardRef,
  useImperativeHandle,
  useRef,
} from "react";

import { X } from "lucide-react";

import type {
  BreakoutRoom,
  ChatMessage,
  CurrentRoomInfo,
  JoinInfo,
  UserRole,
  JitsiParticipant,
} from "./types";

import useAttendance from "./hooks/useAttendance";
import useJitsiScript from "./hooks/useJitsiScript";

import useJitsi, {
  JitsiControls,
} from "./hooks/useJitsi";

/**
 * JitsiMeeting's own exposed ref adds `requestFullscreen` on top of the
 * Jitsi-command-only `JitsiControls` — fullscreening the wrapper div is a
 * plain browser API concern, not a Jitsi `executeCommand`, so it lives here
 * (where the wrapper DOM node actually is) rather than in useJitsi.ts.
 */
export type JitsiMeetingControls = JitsiControls & {
  requestFullscreen: () => void;
};

type JitsiMeetingProps = {
  joinInfo: JoinInfo;
  role: UserRole;
  teacherName: string;

  /** Drives whether the in-classroom "Exit fullscreen" overlay button is shown. */
  isFullscreen?: boolean;

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

  onChatMessage?: (message: ChatMessage) => void;

  /** Fired once the local user's Jitsi conference has actually joined. */
  onConferenceJoined?: () => void;

  /** Fired whenever the local user's real Jitsi role (moderator/none) changes. */
  onModeratorStatusChanged?: (isModerator: boolean) => void;

  onBreakoutRoomsUpdated?: (rooms: BreakoutRoom[]) => void;
  onRoomChanged?: (room: CurrentRoomInfo) => void;
  onBreakoutSupportChanged?: (supported: boolean) => void;

};

const JitsiMeeting = forwardRef<
  JitsiMeetingControls,
  JitsiMeetingProps
>(function JitsiMeeting(
  {
    joinInfo,
    role,
    teacherName,
    isFullscreen = false,
    onParticipantsChanged,
    onParticipantStatusChanged,
    onRecordingStatusChanged,
    onLiveStatusChanged,
    onChatMessage,
    onConferenceJoined,
    onModeratorStatusChanged,
    onBreakoutRoomsUpdated,
    onRoomChanged,
    onBreakoutSupportChanged,
  },
  ref
) {

  const containerRef =
    useRef<HTMLDivElement | null>(null);

  // Fullscreened instead of `containerRef` directly: `containerRef` is Jitsi's own
  // exclusive DOM subtree (it injects its iframe there), so a sibling "Exit
  // fullscreen" button is rendered next to it inside this wrapper instead — fullscreening
  // the wrapper hides everything outside it (our header/right sidebar) while still
  // letting our own overlay button render on top of the Jitsi iframe.
  const fullscreenWrapperRef =
    useRef<HTMLDivElement | null>(null);

  const controlsRef =
    useRef<JitsiControls | null>(null);

  const {
    markJoined,
    markLeft,
  } = useAttendance(
    joinInfo,
    role
  );

  const {
    isJitsiReady,
    errorMessage,
  } = useJitsiScript(
    joinInfo.session.jitsiDomain
  );

  const handleParticipantStatusChanged = (
    participantId: string,
    status: Partial<JitsiParticipant["status"]>
  ) => {
    console.log(
      "🟣 STATUS UPDATE RECEIVED BY JITSI MEETING:",
      participantId,
      status
    );
  };

  useImperativeHandle(
    ref,
    () => ({
      startRecording: () => {
        controlsRef.current?.startRecording();
      },

      stopRecording: () => {
        controlsRef.current?.stopRecording();
      },

      startYouTubeLive: (
        streamKey: string,
        broadcastId: string,
        purpose: "recording" | "live"
      ) => {
        controlsRef.current?.startYouTubeLive(
          streamKey,
          broadcastId,
          purpose
        );
      },

      stopYouTubeLive: () => {
        console.log(
          "🛑 JITSI MEETING STOP LIVE CALLED"
        );

        controlsRef.current?.stopYouTubeLive();
      },

      muteEveryone: () => {
        controlsRef.current?.muteEveryone();
      },

      setParticipantAudioMuted: (
        participantId: string,
        muted: boolean
      ) => {
        controlsRef.current?.setParticipantAudioMuted(
          participantId,
          muted
        );
      },

      sendChatMessage: (message: string) => {
        controlsRef.current?.sendChatMessage(message);
      },

      setVideoQuality: (heightPx: number) => {
        controlsRef.current?.setVideoQuality(heightPx);
      },

      setNoiseSuppression: (enabled: boolean) => {
        controlsRef.current?.setNoiseSuppression(enabled);
      },

      endConference: () => {
        controlsRef.current?.endConference();
      },

      requestFullscreen: () => {
        fullscreenWrapperRef.current
          ?.requestFullscreen()
          .catch((error) => {
            console.error("Unable to enter fullscreen:", error);
          });
      },

      createBreakoutRoom: (name?: string) => {
        controlsRef.current?.createBreakoutRoom(name);
      },

      sendParticipantToBreakoutRoom: (participantJid: string, roomId: string) => {
        controlsRef.current?.sendParticipantToBreakoutRoom(participantJid, roomId);
      },

      autoAssignBreakoutRooms: () => {
        controlsRef.current?.autoAssignBreakoutRooms();
      },

      joinBreakoutRoom: (roomJid: string) => {
        controlsRef.current?.joinBreakoutRoom(roomJid);
      },

      returnToMainRoom: () => {
        controlsRef.current?.returnToMainRoom();
      },

      closeBreakoutRoom: (roomId: string) => {
        controlsRef.current?.closeBreakoutRoom(roomId);
      },

      removeBreakoutRoom: (roomJid: string) => {
        controlsRef.current?.removeBreakoutRoom(roomJid);
      },

      refreshBreakoutRooms: async () =>
        (await controlsRef.current?.refreshBreakoutRooms()) ?? [],
    }),
    []
  );

  useJitsi({
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
    onModeratorStatusChanged,
    onBreakoutRoomsUpdated,
    onRoomChanged,
    onBreakoutSupportChanged,
  });

  return (
    <>
      {errorMessage && (
        <div className="p-4 text-red-400">
          {errorMessage}
        </div>
      )}

      <div
        ref={fullscreenWrapperRef}
        className="relative h-full min-h-0 w-full"
      >
        <div
          ref={containerRef}
          className="h-full min-h-0 w-full"
        />

        {isFullscreen && (
          <button
            type="button"
            onClick={() => {
              document.exitFullscreen().catch((error) => {
                console.error("Unable to exit fullscreen:", error);
              });
            }}
            aria-label="Exit fullscreen"
            className="absolute right-3 top-3 z-50 flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white backdrop-blur transition hover:bg-black/80"
          >
            <X size={18} />
          </button>
        )}
      </div>
    </>
  );
});

export default JitsiMeeting;



// "use client";

// import {
//   forwardRef,
//   useImperativeHandle,
//   useRef,
// } from "react";

// import type {
//   JoinInfo,
//   UserRole,
//   JitsiParticipant,
// } from "./types";

// import useAttendance from "./hooks/useAttendance";
// import useJitsiScript from "./hooks/useJitsiScript";

// import useJitsi, {
//   JitsiControls,
// } from "./hooks/useJitsi";

// type JitsiMeetingProps = {
//   joinInfo: JoinInfo;
//   role: UserRole;
//   teacherName: string;

//   onParticipantsChanged?: (
//     participants: JitsiParticipant[]
//   ) => void;
//   onParticipantStatusChanged?: (
//     participantId: string,
//     status: {
//       audioMuted?: boolean;
//       videoMuted?: boolean;
//     }
//   ) => void;
// };

// export default function JitsiMeeting({
//   joinInfo,
//   role,
//   teacherName,
//   onParticipantsChanged,
//   onParticipantStatusChanged,
// }: JitsiMeetingProps) {

//   const containerRef =
//     useRef<HTMLDivElement | null>(null);

//   const {
//     markJoined,
//     markLeft,
//   } = useAttendance(
//     joinInfo,
//     role
//   );

//   const {
//     isJitsiReady,
//     errorMessage,
//   } = useJitsiScript(
//     joinInfo.session.jitsiDomain
//   );


//   const handleParticipantStatusChanged = (
//     participantId: string,
//     status: Partial<JitsiParticipant["status"]>
//   ) => {
//     console.log(
//       "🟣 STATUS UPDATE RECEIVED BY JITSI MEETING:",
//       participantId,
//       status
//     );
//   };

//   useJitsi({
//     containerRef,
//     joinInfo,
//     role,
//     teacherName,
//     isJitsiReady,
//     markJoined,
//     markLeft,
//     onParticipantsChanged,
//     onParticipantStatusChanged,
    
//   });

//   return (
//     <>
//       {errorMessage && (
//         <div className="p-4 text-red-400">
//           {errorMessage}
//         </div>
//       )}

//       <div
//         ref={containerRef}
//         className="h-full min-h-0 w-full"
//       />
//     </>
//   );
// }