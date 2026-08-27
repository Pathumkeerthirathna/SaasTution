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
    <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-[#0B1220] px-4 py-8">

      <div className="w-full max-w-4xl rounded-2xl border border-slate-800 bg-[#0F172A] p-6 shadow-xl sm:p-8">

        <div className="grid w-full gap-8 lg:grid-cols-2">

          {/* LEFT */}

          <div>

            <DevicePreview
              videoRef={videoRef}
              cameraEnabled={cameraEnabled}
            />

            <MediaControls
              cameraEnabled={cameraEnabled}
              microphoneEnabled={microphoneEnabled}
              onToggleCamera={toggleCamera}
              onToggleMicrophone={toggleMicrophone}
          />

          <MicrophoneLevel level={level} />

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

          {/* RIGHT */}

          <div>

            <h1 className="text-xl font-semibold text-white">
              Device Setup
            </h1>

            <p className="mt-1.5 text-sm text-slate-400">
              Select the camera, microphone and speaker
              before joining your live classroom.
            </p>

            <div className="mt-6">

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

        </div>

      </div>

    </div>
  );
}