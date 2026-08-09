"use client";

import { ReactNode,useState  } from "react";

import DevicePreview from "./DevicePreview";
import DeviceSelector from "./DeviceSelector";

import useMediaDevices from "./hooks/useMediaDevices";

import MediaControls from "./MediaControls";
import useMicrophoneLevel from "./hooks/useMicrophoneLevel";
import MicrophoneLevel from "../MicrophoneLevel";

type PermissionGateProps = {
  children: ReactNode;
};

export default function PermissionGate({
  children,
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

  if (permissionGranted && joinMeeting) {
    return <>{children}</>;
}



  return (
    <div className="mx-auto flex w-full max-w-6xl items-center justify-center py-12 p-4">

      <div className="grid w-full gap-10 lg:grid-cols-2">

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
            className="mt-6 w-full rounded-xl bg-green-600 py-3 font-semibold text-white transition hover:bg-green-700"
          >
            Join Classroom
          </button>
        )}

          <button
            onClick={requestPermission}
            disabled={checking || permissionGranted}
            className="mt-6 w-full rounded-xl bg-blue-600 py-3 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
          >
            {permissionGranted
              ? "Permissions Granted"
              : checking
                  ? "Checking devices..."
                  : "Allow Camera & Microphone"}
          </button>

          {error && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {error}
            </div>
          )}

        </div>

        {/* RIGHT */}

        <div>

          <h1 className="text-3xl font-bold">
            Device Setup
          </h1>

          <p className="mt-2 text-slate-500">
            Select the camera, microphone and speaker
            before joining your live classroom.
          </p>

          <div className="mt-8">

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
  );
}