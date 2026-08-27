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
import toast from "react-hot-toast";
import { getYoutubeFriendlyErrorMessage } from "@/lib/youtube-error-messages";
import { announce } from "@/lib/voice-announcer";



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

  const [isStartingLive, setIsStartingLive] =
  useState(false);

  const [liveStartFailed, setLiveStartFailed] =
  useState(false);

  const [youtubePrivacy, setYoutubePrivacy] =
  useState<"public" | "unlisted" | "private">(
    "unlisted"
  );


  const [showYoutubePrivacy, setShowYoutubePrivacy] =
  useState(false);

  const jitsiMeetingRef =
  useRef<JitsiControls | null>(null);

  const youtubeLiveRequestedRef =
  useRef(false);

  const [youtubeLiveUrl, setYoutubeLiveUrl] =
    useState<string | null>(null);

  // const testRecordingControl = () => {
  //   jitsiMeetingRef.current?.startRecording();
  // };

  const [youtubeLiveReusedRecording, setYoutubeLiveReusedRecording] =
    useState(false);

  const [meetingReady, setMeetingReady] =
    useState(false);


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
      <main className="flex h-screen w-full items-center justify-center bg-[#0B1120]">
        <div className="flex flex-col items-center text-center">

          {/* SL Classroom Logo */}
          <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-[#3B82F6]/10 ring-1 ring-[#3B82F6]/30">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[#3B82F6] shadow-lg shadow-[#3B82F6]/30">
              <span className="text-2xl font-bold text-white">
                SL
              </span>
            </div>
          </div>

          {/* Brand */}
          <h1 className="text-3xl font-bold tracking-tight text-[#F8FAFC]">
            SL Classroom
          </h1>

          <p className="mt-2 text-sm text-[#94A3B8]">
            Your virtual classroom is getting ready
          </p>

          {/* Loader */}
          <div className="mt-8 flex items-center gap-3">

            <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#1E293B] border-t-[#3B82F6]" />

            <span className="text-sm font-medium text-[#CBD5E1]">
              Joining classroom...
            </span>

          </div>

          {/* Small status */}
          <div className="mt-6 flex items-center gap-2 text-xs text-[#64748B]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-[#3B82F6]" />
            Connecting securely
          </div>

        </div>
      </main>
    );
  }

  // Error
  if (error || !joinInfo) {
    return (
      <main className="flex h-screen w-full items-center justify-center bg-[#0B1120]">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-[#F8FAFC]">
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

    const lectureId = joinInfo.lecture?.id;

    if (!lectureId) {
      console.error("❌ No lecture ID available.");
      return;
    }

    setLiveStartFailed(false);

    try {
      const response = await fetch(
        "/api/youtube/lecture/start",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            lectureId,
            privacy: youtubePrivacy,
          }),
        }
      );

      const data = await response.json();

      console.log(
        "🎥 YOUTUBE LIVE START RESPONSE:",
        data
      );

      if (!response.ok || !data.success) {
        throw new Error(
          data.error ?? "Unable to start YouTube Live."
        );
      }

      if (!data.streamName) {
        throw new Error(
          "YouTube stream key is missing."
        );
      }

      if (!data.broadcastId) {
        throw new Error(
          "YouTube broadcast ID is missing."
        );
      }

      console.log(
        "🔴 YOUTUBE LIVE PREPARED:",
        data
      );

      setYoutubeLiveUrl(data.youtubeUrl);

      setYoutubeLiveReusedRecording(
          data.reusedRecording === true
      );

      if (!data.alreadyStreaming) {
          console.log(
            "🚀 Starting Jitsi → YouTube stream..."
          );

          jitsiMeetingRef.current?.startYouTubeLive(
            data.streamName,
            data.broadcastId,
            "live"
          );

      } else {

        console.log(
          "♻️ Reusing existing active YouTube stream."
        );

      }

      // API succeeded → mark YouTube Live as active
      setIsLive(true);

      announce("Live stream has started.");

    } catch (error) {
      console.error(
        "❌ Failed to start YouTube live:",
        error
      );

      // Important: don't leave the UI showing Live
      setIsLive(false);
      setLiveStartFailed(true);

      toast.error(
        getYoutubeFriendlyErrorMessage(
          error instanceof Error
            ? error.message
            : undefined,
          "live"
        )
      );

      throw error;
    }
  };

  const handleStartYouTubeRecording = async () => {

    console.log("🎥 START YOUTUBE RECORDING BUTTON CLICKED");

    youtubeLiveRequestedRef.current = false;

    const lectureId =
      joinInfo.lecture?.id;

    if (!lectureId) {
      console.error("❌ No lecture ID available.");
      return;
    }

    try {
      const response = await fetch(
        "/api/youtube/lecture/recording/start",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            lectureId,
            privacy: "unlisted",
            isLive,
          }),
        }
      );

      const data = await response.json();

      console.log(
        "🎥 YOUTUBE RECORDING START RESPONSE:",
        data
      );

      if (!data.success) {
        throw new Error(
          data.error ?? "Unable to start YouTube recording."
        );
      }

      if (!data.streamName) {
        throw new Error(
          "YouTube stream key is missing."
        );
      }

      if (!data.broadcastId) {
        throw new Error(
          "YouTube broadcast ID is missing."
        );
      }

      console.log(
        "🚀 Starting Jitsi → YouTube recording..."
      );

       setIsRecording(true);

       announce("Recording has started.");

      // jitsiMeetingRef.current?.startYouTubeLive(
      //   data.streamName,
      //   data.broadcastId
      // );

      if (data.alreadyStreaming) {
        console.log(
          "♻️ YouTube reusable stream is already active. Reusing it."
        );
      } else {
        console.log(
          "🚀 YouTube stream is inactive. Starting Jitsi → YouTube..."
        );

        jitsiMeetingRef.current?.startYouTubeLive(
          data.streamName,
          data.broadcastId,
          "recording"
        );
      }

     
    } catch (error) {
      console.error(
        "❌ Failed to start YouTube recording:",
        error
      );

      toast.error(
        getYoutubeFriendlyErrorMessage(
          error instanceof Error
            ? error.message
            : undefined,
          "recording"
        )
      );

      throw error;
    }
  };

  return (
  <main className="h-screen w-full overflow-hidden bg-[#0B1120]">

    <div
      className={
        meetingReady
          ? "grid h-full min-h-0 w-full grid-cols-[minmax(0,1fr)_72px]"
          : "grid h-full min-h-0 w-full grid-cols-1"
      }
    >

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
        isStartingLive={isStartingLive}
        liveStartFailed={liveStartFailed}
        showHeader={meetingReady}
        youtubeLiveUrl={youtubeLiveUrl}
        youtubeChannelTitle={
          joinInfo.youtube?.channelTitle
        }
        youtubeStatus={
          joinInfo.youtube?.status
        }
        onStartRecording={() => {
           console.log("🎥 RECORD BUTTON CLICKED");

           return handleStartYouTubeRecording();
        }}
      onStopRecording={async () => {
        console.log(
            "🛑 STOP RECORDING BUTTON CLICKED"
        );

        const lectureId =
            joinInfo.lecture?.id;

        if (!lectureId) {
            console.error(
                "❌ No lecture ID available."
            );
            return;
        }

        try {

            /*
            * First tell backend to stop the
            * specific YouTube recording broadcast.
            */
            const response =
                await fetch(
                    "/api/youtube/lecture/recording/stop",
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

            const data =
                await response.json();

            console.log(
                "⏹ YOUTUBE RECORDING STOP RESPONSE:",
                data
            );

            if (!data.success) {
                console.error(
                    "❌ Failed to stop YouTube recording:",
                    data.error
                );

                return;
            }

            /*
            * Now stop the Jitsi recording itself.
            *
            * This does NOT mean stopping the
            * shared YouTube/Jibri stream.
            */
            // jitsiMeetingRef.current?.stopRecording();

            setIsRecording(false);

            announce("Recording has stopped.");

            if (!isLive) {
            console.log(
                "🛑 Recording and Live are both stopped."
            );

            console.log(
                "🛑 Stopping shared Jitsi/Jibri stream..."
            );

            jitsiMeetingRef.current?.stopYouTubeLive();
        } else {
            console.log(
                "🔴 Live is still active. Keeping shared Jitsi/Jibri stream alive."
            );
        }

        } catch (error) {

            console.error(
                "❌ Failed to stop YouTube recording:",
                error
            );
        }
    }}

        onStartLive={() => {
          console.log("🔴 START LIVE BUTTON CLICKED");
          setShowYoutubePrivacy(true);
        }}

        onStopLive={async () => {

          if (
              youtubeLiveReusedRecording &&
              isRecording
          ) {
              console.log(
                  "♻️ This Live uses the active recording broadcast."
              );

              console.log(
                  "⏹ Stopping Live mode only. Recording will continue."
              );

              setIsLive(false);

              setYoutubeLiveUrl(null);

              setYoutubeLiveReusedRecording(false);

              announce("Live stream has stopped.");

              return;
          }

          console.log("🛑 STOP LIVE BUTTON CLICKED");

          youtubeLiveRequestedRef.current = false;

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
              "/api/youtube/lecture/stop",
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

            const data =
              await response.json();

            console.log(
              "🎥 YOUTUBE STOP LIVE RESPONSE:",
              data
            );

            if (!data.success) {
              console.error(
                "❌ Failed to stop YouTube Live:",
                data.error
              );
              return;
            }

            /*
            * Only update the UI after the backend
            * successfully stopped the Live broadcast.
            */
            setIsLive(false);

            announce("Live stream has stopped.");

            if (!isRecording) {
              console.log(
                  "🛑 Live and Recording are both stopped."
              );

              console.log(
                  "🛑 Stopping shared Jitsi/Jibri stream..."
              );

              jitsiMeetingRef.current?.stopYouTubeLive();
          } else {
              console.log(
                  "⏺ Recording is still active. Keeping shared Jitsi/Jibri stream alive."
              );
          }

            /*
            * IMPORTANT:
            *
            * Do NOT call:
            *
            * jitsiMeetingRef.current?.stopYouTubeLive();
            *
            * here.
            *
            * Recording may still be using the same
            * Jitsi → YouTube reusable stream.
            */

          } catch (error) {

            console.error(
              "❌ Failed to stop YouTube Live:",
              error
            );
          }
        }}
      >
        <PermissionGate onReadyChange={setMeetingReady}>
          <JitsiMeeting
            ref={jitsiMeetingRef}
            onRecordingStatusChanged={(recording) => {
              console.log(
                "🎥 CLASSROOM RECORDING STATUS:",
                recording
              );

              //setIsRecording(recording);
            }}
            onLiveStatusChanged={(live) => {
              console.log(
                "🔴 CLASSROOM LIVE STATUS:",
                live
              );

              // Only update the Live button state when
              // the teacher explicitly started YouTube Live.
              if (youtubeLiveRequestedRef.current) {
                setIsLive(live);
              }
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

      {showYoutubePrivacy && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="w-full max-w-sm rounded-2xl border border-[#1E293B] bg-[#172033] p-5 shadow-2xl">

          <div className="mb-5">
            <h3 className="text-lg font-semibold text-[#F8FAFC]">
              Start YouTube Live
            </h3>

            <p className="mt-1 text-sm text-[#94A3B8]">
              Choose who can watch your live stream.
            </p>
          </div>

          <div className="space-y-3">

            {/* PUBLIC */}
            <button
              type="button"
              onClick={() => {
                setYoutubePrivacy("public");
              }}
              className={`w-full rounded-xl border p-4 text-left transition ${
                youtubePrivacy === "public"
                  ? "border-[#3B82F6] bg-[#3B82F6]/10"
                  : "border-[#1E293B] bg-[#1E293B]/50 hover:bg-[#1E293B]"
              }`}
            >
              <div className="font-semibold text-[#F8FAFC]">
                Public
              </div>

              <div className="mt-1 text-xs text-[#94A3B8]">
                Anyone can find and watch this live stream.
              </div>
            </button>

            {/* UNLISTED */}
            <button
              type="button"
              onClick={() => {
                setYoutubePrivacy("unlisted");
              }}
              className={`w-full rounded-xl border p-4 text-left transition ${
                youtubePrivacy === "unlisted"
                  ? "border-[#3B82F6] bg-[#3B82F6]/10"
                  : "border-[#1E293B] bg-[#1E293B]/50 hover:bg-[#1E293B]"
              }`}
            >
              <div className="font-semibold text-[#F8FAFC]">
                Unlisted
              </div>

              <div className="mt-1 text-xs text-[#94A3B8]">
                Only people with the link can watch.
              </div>
            </button>

            {/* PRIVATE */}
            <button
              type="button"
              onClick={() => {
                setYoutubePrivacy("private");
              }}
              className={`w-full rounded-xl border p-4 text-left transition ${
                youtubePrivacy === "private"
                  ? "border-[#3B82F6] bg-[#3B82F6]/10"
                  : "border-[#1E293B] bg-[#1E293B]/50 hover:bg-[#1E293B]"
              }`}
            >
              <div className="font-semibold text-[#F8FAFC]">
                Private
              </div>

              <div className="mt-1 text-xs text-[#94A3B8]">
                Only you and authorized viewers can watch.
              </div>
            </button>

          </div>

          <div className="mt-6 flex justify-end gap-3">

            <button
              type="button"
              onClick={() => {
                setShowYoutubePrivacy(false);
              }}
              className="rounded-lg px-4 py-2 text-sm font-medium text-[#CBD5E1] transition hover:bg-[#1E293B]"
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={async () => {
                setShowYoutubePrivacy(false);

                youtubeLiveRequestedRef.current = true;

                setIsStartingLive(true);

                try {
                  await handleStartYouTubeLive();
                } catch {
                  // Error already surfaced via toast inside handleStartYouTubeLive.
                } finally {
                  setIsStartingLive(false);
                }
              }}
              className="rounded-lg bg-[#EF4444] px-5 py-2 text-sm font-semibold text-white transition hover:bg-[#DC2626]"
            >
              Start Live
            </button>

          </div>

        </div>
      </div>
    )}

      {/* RIGHT SIDEBAR */}
      {meetingReady && (
        <RightSidebar
          classId={joinInfo.class.id}
          className={joinInfo.class.name}
          lectureTitle={joinInfo.lecture?.title}
          teacherName={teacherName}
          role={role}
          participants={participants}
          ClassroomStudents={classStudents}
        />
      )}

    </div>

  </main>
);
}