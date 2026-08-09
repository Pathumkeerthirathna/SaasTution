"use client";

import { useRef } from "react";

import type {
  JoinInfo,
  UserRole,
  JitsiParticipant,
} from "./types";

import useAttendance from "./hooks/useAttendance";
import useJitsiScript from "./hooks/useJitsiScript";
import useJitsi from "./hooks/useJitsi";

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
};

export default function JitsiMeeting({
  joinInfo,
  role,
  teacherName,
  onParticipantsChanged,
  onParticipantStatusChanged,
}: JitsiMeetingProps) {

  const containerRef =
    useRef<HTMLDivElement | null>(null);

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

  useJitsi({
    containerRef,
    joinInfo,
    role,
    teacherName,
    isJitsiReady,
    markJoined,
    markLeft,
    onParticipantsChanged,
    onParticipantStatusChanged,
    
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
}