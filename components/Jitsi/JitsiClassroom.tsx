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

    const lectureId = joinInfo.lecture?.id;

    if (!lectureId) {
      console.error("❌ No lecture ID available.");
      return;
    }

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

          const errorMessage =
              typeof data.error === "string"
                  ? data.error.toLowerCase()
                  : "";

          if (
              errorMessage.includes(
                  "connection pool timeout"
              ) ||
              errorMessage.includes(
                  "timed out fetching a new connection"
              )
          ) {
              toast.error(
                  "Connection problem. Please check your internet connection and try again."
              );

              return;
          }

          toast.error(
              data.error ??
              "Unable to start YouTube Live."
          );

          return;
      }

      if (!data.success) {
        console.error(
          "❌ YouTube live could not be prepared."
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

    } catch (error) {
      console.error(
        "❌ Failed to start YouTube live:",
        error
      );

      // Important: don't leave the UI showing Live
      setIsLive(false);

      const errorMessage =
        error instanceof Error
            ? error.message.toLowerCase()
            : "";

    if (
        errorMessage.includes(
            "connection pool timeout"
        ) ||
        errorMessage.includes(
            "timed out fetching a new connection"
        )
    ) {
        toast.error(
            "Connection problem. Please check your internet connection and try again."
        );

        return;
    }

    toast.error(
        error instanceof Error
            ? error.message
            : "Unable to start YouTube Live."
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
        console.error(
          "❌ YouTube recording could not be prepared."
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
        "🚀 Starting Jitsi → YouTube recording..."
      );

       setIsRecording(true);

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
        error instanceof Error
          ? error.message
          : "Something went wrong while starting the YouTube recording."
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
        isStartingLive={isStartingLive}
        youtubeLiveUrl={youtubeLiveUrl}
        youtubeChannelTitle={
          joinInfo.youtube?.channelTitle
        }
        youtubeStatus={
          joinInfo.youtube?.status
        }
        onStartRecording={() => {
           console.log("🎥 RECORD BUTTON CLICKED");

           void handleStartYouTubeRecording();
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
        <PermissionGate>
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
        <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-[#0F172A] p-5 shadow-2xl">

          <div className="mb-5">
            <h3 className="text-lg font-semibold text-white">
              Start YouTube Live
            </h3>

            <p className="mt-1 text-sm text-slate-400">
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
                  ? "border-blue-500 bg-blue-500/10"
                  : "border-slate-700 bg-slate-800/50 hover:bg-slate-800"
              }`}
            >
              <div className="font-semibold text-white">
                Public
              </div>

              <div className="mt-1 text-xs text-slate-400">
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
                  ? "border-blue-500 bg-blue-500/10"
                  : "border-slate-700 bg-slate-800/50 hover:bg-slate-800"
              }`}
            >
              <div className="font-semibold text-white">
                Unlisted
              </div>

              <div className="mt-1 text-xs text-slate-400">
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
                  ? "border-blue-500 bg-blue-500/10"
                  : "border-slate-700 bg-slate-800/50 hover:bg-slate-800"
              }`}
            >
              <div className="font-semibold text-white">
                Private
              </div>

              <div className="mt-1 text-xs text-slate-400">
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
              className="rounded-lg px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-800"
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
                } finally {
                  setIsStartingLive(false);
                }
              }}
              className="rounded-lg bg-red-500 px-5 py-2 text-sm font-semibold text-white transition hover:bg-red-600"
            >
              Start Live
            </button>

          </div>

        </div>
      </div>
    )}

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