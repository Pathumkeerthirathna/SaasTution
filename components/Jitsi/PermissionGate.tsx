"use client";

import { ReactNode, useEffect, useState } from "react";

import DevicePreview from "./DevicePreview";
import DeviceSelector from "./DeviceSelector";

import useMediaDevices from "./hooks/useMediaDevices";

import MediaControls from "./MediaControls";
import useMicrophoneLevel from "./hooks/useMicrophoneLevel";
import MicrophoneLevel from "../MicrophoneLevel";

type PermissionGateProps = {
  children: ReactNode;
  onReadyChange?: (ready: boolean) => void;
};

export default function PermissionGate({
  children,
  onReadyChange,
}: PermissionGateProps) {
  const {
    stream,
  videoRef,

  cameras,
  microphones,
  speakers,

  selectedCamera,
  selectedMicrophone,
  selectedSpeaker,

  setSelectedCamera,
  setSelectedMicrophone,
  setSelectedSpeaker,

  permissionGranted,
  checking,
  error,

  requestPermission,

  cameraEnabled,
  microphoneEnabled,

  toggleCamera,
  toggleMicrophone,
} = useMediaDevices();

const [joinMeeting, setJoinMeeting] = useState(false);

const level = useMicrophoneLevel(stream);

  const ready = permissionGranted && joinMeeting;

  useEffect(() => {
    onReadyChange?.(ready);
  }, [ready]);

  if (ready) {
    return <>{children}</>;
}

  return (
    // items-start on short/landscape viewports so a tall stack of content can
    // always be scrolled to from the top — items-center + overflow can leave
    // the top of tall content unreachable when it doesn't fit the viewport.
    <div className="flex h-full w-full items-start justify-center overflow-y-auto bg-[#0B1220] px-3 py-6 sm:items-center sm:px-4 sm:py-8">

      <div className="w-full max-w-4xl rounded-2xl border border-slate-800 bg-[#0F172A] p-4 shadow-xl sm:p-6 lg:p-8">

        {/*
          Single column (stacked, in the exact order requested) below `md`;
          two columns from `md` up (tablets get two columns as soon as there's
          room, not only at a desktop-sized `lg` breakpoint). The two groups
          below use `display: contents` on mobile so their children flatten
          into one ordered list (positioned purely with `order-*`), then become
          real grid cells at `md` (positioned with `md:col-start-*`) — this
          reproduces the original two independently-flowing columns exactly,
          without one column's row heights ever being stretched by the other's.
        */}
        <div className="grid grid-cols-1 md:grid-cols-2 md:gap-x-8 lg:gap-x-10">

          {/* Column 2 on desktop: heading + device selectors */}
          <div className="contents md:block md:col-start-2">

            <div className="order-1">
              <h1 className="text-lg font-semibold text-white sm:text-xl">
                Device Setup
              </h1>

              <p className="mt-1.5 text-xs text-slate-400 sm:text-sm">
                Select the camera, microphone and speaker
                before joining your live classroom.
              </p>
            </div>

            <div className="order-5 mt-6">
              <DeviceSelector
                cameras={cameras}
                microphones={microphones}
                speakers={speakers}

                selectedCamera={selectedCamera}
                selectedMicrophone={selectedMicrophone}
                selectedSpeaker={selectedSpeaker}

                onCameraChange={setSelectedCamera}
                onMicrophoneChange={setSelectedMicrophone}
                onSpeakerChange={setSelectedSpeaker}
              />
            </div>

          </div>

          {/* Column 1 on desktop: preview, toggles, mic level, action buttons */}
          <div className="contents md:block md:col-start-1">

            <div className="order-2 mt-6 md:mt-0">
              <DevicePreview
                videoRef={videoRef}
                cameraEnabled={cameraEnabled}
              />
            </div>

            <div className="order-3">
              <MediaControls
                cameraEnabled={cameraEnabled}
                microphoneEnabled={microphoneEnabled}
                onToggleCamera={toggleCamera}
                onToggleMicrophone={toggleMicrophone}
              />
            </div>

            <div className="order-4">
              <MicrophoneLevel level={level} />
            </div>

            <div className="order-6">
              {permissionGranted && (
                <button
                  onClick={() => setJoinMeeting(true)}
                  className="mt-4 w-full rounded-lg bg-green-600 py-2.5 text-sm font-semibold text-white transition hover:bg-green-500"
                >
                  Join Classroom
                </button>
              )}

              <button
                onClick={requestPermission}
                disabled={checking || permissionGranted}
                className="mt-3 w-full rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {permissionGranted
                  ? "Permissions Granted"
                  : checking
                      ? "Checking devices..."
                      : "Allow Camera & Microphone"}
              </button>

              {error && (
                <div className="mt-3 rounded-lg border border-red-900/50 bg-red-950/40 p-3 text-xs text-red-300">
                  {error}
                </div>
              )}
            </div>

          </div>

        </div>

      </div>

    </div>
  );
}
