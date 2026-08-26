

"use client";

import {
  forwardRef,
  useImperativeHandle,
  useRef,
} from "react";

import type {
  JoinInfo,
  UserRole,
  JitsiParticipant,
} from "./types";

import useAttendance from "./hooks/useAttendance";
import useJitsiScript from "./hooks/useJitsiScript";

import useJitsi, {
  JitsiControls,
} from "./hooks/useJitsi";

type JitsiMeetingProps = {
  joinInfo: JoinInfo;
  role: UserRole;
  teacherName: string;

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

const JitsiMeeting = forwardRef<
  JitsiControls,
  JitsiMeetingProps
>(function JitsiMeeting(
  {
    joinInfo,
    role,
    teacherName,
    onParticipantsChanged,
    onParticipantStatusChanged,
    onRecordingStatusChanged,
    onLiveStatusChanged
  },
  ref
) {

  const containerRef =
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
  });

  return (
    <>
      {errorMessage && (
        <div className="p-4 text-red-400">
          {errorMessage}
        </div>
      )}

      <div
        ref={containerRef}
        className="h-full min-h-0 w-full"
      />
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