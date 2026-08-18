"use client";

import PermissionGate from "./PermissionGate";
import JitsiMeeting from "./JitsiMeeting";

import useJoinSession from "./hooks/useJoinSession";
import MeetingCard from "./classroom/meeting/MeetingCard";
import RightSidebar from "./classroom/sidebar/RightSidebar";
import useParticipants from "./hooks/useParticipants";

import { useCallback,useRef, useEffect, useState } from "react";
import { ClassroomStudent, JitsiParticipant } from "./types";
import { ClassStudent } from "@prisma/client";
import { ClassItem } from "../class-management-panel";

import type { JitsiControls } from "./hooks/useJitsi";



export default function JitsiClassroom() {
  const {
    joinInfo,
    loading,
    error,
    role,
    teacherName,
  } = useJoinSession();

  const {
    participants,
    setParticipants,
  } = useParticipants();

  console.log(
    "🔴 JitsiClassroom PARTICIPANTS:",
    participants
  );

  console.log(
    "🔴 JitsiClassroom COUNT:",
    participants.length
  );

const [classStudents, setClassStudents] =
  useState<ClassroomStudent[]>([]);

  const [isRecording, setIsRecording] =
  useState(false);

  const [isLive, setIsLive] =
  useState(false);

  const jitsiMeetingRef =
  useRef<JitsiControls | null>(null);

  // const testRecordingControl = () => {
  //   jitsiMeetingRef.current?.startRecording();
  // };


  const handleParticipantsChanged = useCallback(
    (newParticipants: JitsiParticipant[]) => {

      console.log(
        "🟣 JitsiMeeting SENT PARTICIPANTS:",
        newParticipants
      );

      console.log(
        "🟣 COUNT:",
        newParticipants.length
      );

      setParticipants(newParticipants);

    },
    [setParticipants]
  );

  useEffect(() => {
    if (!joinInfo) {
        return;
    }

    console.log(role);

    const loadClassStudents = async () => {
        const response = await fetch(
            `/api/classes/${joinInfo.class.id}/ClassParticipants`
        );

        if (!response.ok) {
            throw new Error("Failed to load class students");
        }

        const data = await response.json();

        setClassStudents(data.data);

        console.log(data);
    };

    if(role=="teacher")
      void loadClassStudents();

}, [joinInfo]);

  // Loading
  if (loading) {
    return (
      <main className="flex h-screen w-full items-center justify-center bg-[#0B1220]">
        <div className="flex flex-col items-center text-center">

          {/* SL Classroom Logo */}
          <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-blue-600/10 ring-1 ring-blue-500/30">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-blue-600 shadow-lg shadow-blue-600/30">
              <span className="text-2xl font-bold text-white">
                SL
              </span>
            </div>
          </div>

          {/* Brand */}
          <h1 className="text-3xl font-bold tracking-tight text-white">
            SL Classroom
          </h1>

          <p className="mt-2 text-sm text-slate-400">
            Your virtual classroom is getting ready
          </p>

          {/* Loader */}
          <div className="mt-8 flex items-center gap-3">

            <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />

            <span className="text-sm font-medium text-slate-300">
              Joining classroom...
            </span>

          </div>

          {/* Small status */}
          <div className="mt-6 flex items-center gap-2 text-xs text-slate-500">
            <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
            Connecting securely
          </div>

        </div>
      </main>
    );
  }

  // Error
  if (error || !joinInfo) {
    return (
      <main className="flex h-screen w-full items-center justify-center bg-[#0f172a]">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-white">
            Unable to Join Classroom
          </h2>

          <p className="mt-2 text-sm text-red-400">
            {error ?? "Unknown error."}
          </p>
        </div>
      </main>
    );
  }

  const handleStartYouTubeLive = async () => {
    console.log("🔴 START LIVE BUTTON CLICKED");

    const lectureId =
      joinInfo.lecture?.id;

    if (!lectureId) {
      console.error(
        "❌ No lecture ID available."
      );
      return;
    }

    try {
      const response = await fetch(
        "/api/youtube/lecture/start",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            lectureId,
          }),
        }
      );

      const data = await response.json();

      console.log(
        "🎥 YOUTUBE START RESPONSE:",
        data
      );

      if (!data.success) {
        console.error(
          "❌ YouTube broadcast could not be prepared."
        );
        return;
      }

      if (!data.streamName) {
        console.error(
          "❌ YouTube stream key is missing."
        );
        return;
      }

      if (!data.broadcastId) {
        console.error(
          "❌ YouTube broadcast ID is missing."
        );
        return;
      }

      console.log(
        "🚀 Starting Jitsi → YouTube stream..."
      );

      jitsiMeetingRef.current?.startYouTubeLive(
        data.streamName,
        data.broadcastId
      );

    } catch (error) {
      console.error(
        "❌ Failed to start YouTube:",
        error
      );
    }
  };

  return (
  <main className="h-screen w-full overflow-hidden bg-[#0F172A]">

    <div className="grid h-full min-h-0 w-full grid-cols-[minmax(0,1fr)_72px]">

      {/* <button
        type="button"
        onClick={testRecordingControl}
        className="rounded-lg bg-red-600 px-4 py-2 text-white"
      >
        Test Recording Control
      </button> */}

      {/* MAIN CLASSROOM */}
      <MeetingCard
        className={joinInfo.class.name}
        lectureTitle={joinInfo.lecture?.title}
        teacherName={teacherName}
        role={role}
        isRecording={isRecording}
        isLive={isLive}
        onStartRecording={() => {
          console.log("🎥 RECORD BUTTON CLICKED");

          jitsiMeetingRef.current?.startRecording();

          setIsRecording(true);
        }}
        onStopRecording={() => {
          console.log("🛑 STOP RECORDING BUTTON CLICKED");

          jitsiMeetingRef.current?.stopRecording();

           setIsRecording(false);
        }}

        onStartLive={handleStartYouTubeLive}

        onStopLive={() => {
          console.log("🛑 STOP LIVE BUTTON CLICKED");

          jitsiMeetingRef.current?.stopYouTubeLive();
        }}
      >
        <PermissionGate>
          <JitsiMeeting
            ref={jitsiMeetingRef}
            onRecordingStatusChanged={(recording) => {
              console.log(
                "🎥 CLASSROOM RECORDING STATUS:",
                recording
              );

              setIsRecording(recording);
            }}
            onLiveStatusChanged={(live) => {
              console.log(
                "🔴 CLASSROOM LIVE STATUS:",
                live
              );

              setIsLive(live);
            }}
            joinInfo={joinInfo}
            role={role}
            teacherName={teacherName}
            onParticipantsChanged={handleParticipantsChanged}
            onParticipantStatusChanged={(
              participantId,
              status
            ) => {

              console.log(
                "🟣 PARTICIPANT STATUS UPDATE:",
                participantId,
                status
              );

              setParticipants((previous) =>
                previous.map((participant) =>
                  participant.participantId === participantId
                    ? {
                        ...participant,
                        status: {
                          ...participant.status,
                          ...status,
                        },
                      }
                    : participant
                )
              );
            }}
          />
        </PermissionGate>
      </MeetingCard>

      {/* RIGHT SIDEBAR */}
      <RightSidebar
        className={joinInfo.class.name}
        lectureTitle={joinInfo.lecture?.title}
        teacherName={teacherName}
        role={role}
        participants={participants}
        ClassroomStudents={classStudents}
      />

    </div>

  </main>
);
}