"use client";

import { ReactNode, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

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
    // The outer box scrolls; the card centres itself with m-auto, so content
    // taller than the screen (short laptops, landscape phones) still scrolls
    // from its top instead of being cut off above it.
    <div className="flex h-full w-full overflow-y-auto overflow-x-hidden bg-[#0B1220] px-3 py-4 min-[400px]:px-4 sm:px-6 sm:py-8">

      <div className="m-auto w-full max-w-[960px] rounded-2xl border border-white/[0.07] bg-[#0F172A] p-4 shadow-[0_24px_60px_-28px_rgba(2,6,23,0.9)] sm:p-6 lg:p-7">

        <header className="mb-4 sm:mb-5">
          <h1 className="text-lg font-semibold tracking-[-0.01em] text-white sm:text-xl">
            Device Setup
          </h1>

          <p className="mt-1 text-[13px] leading-snug text-slate-400">
            Select the camera, microphone and speaker
            before joining your live classroom.
          </p>
        </header>

        {/*
          Laid out by the card's OWN width (a container query), not the
          device type: the classroom's side rail and paddings change the room
          available. One column below 36rem of content (phones, narrow
          tablets); from there two columns, the preview side a little wider:
          preview + toggles + mic level | device selectors + actions.
        */}
        <div className="[container-type:inline-size]">
          <div className="grid grid-cols-1 gap-5 [@container_(min-width:36rem)]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] [@container_(min-width:36rem)]:gap-6 [@container_(min-width:52rem)]:gap-8">

            {/* Preview, camera / microphone toggles, microphone level */}
            <div className="min-w-0">
              <DevicePreview
                videoRef={videoRef}
                cameraEnabled={cameraEnabled}
                permissionGranted={permissionGranted}
                checking={checking}
              />

              <div className="mt-3 flex items-center gap-3">
                <MediaControls
                  cameraEnabled={cameraEnabled}
                  microphoneEnabled={microphoneEnabled}
                  onToggleCamera={toggleCamera}
                  onToggleMicrophone={toggleMicrophone}
                  disabled={!permissionGranted}
                />

                <MicrophoneLevel level={level} />
              </div>
            </div>

            {/* Device selectors, then the main action */}
            <div className="flex min-w-0 flex-col">
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

                permissionGranted={permissionGranted}
              />

              {/* mt-auto: on two columns the action sits at the bottom of the
                  selectors column, level with the end of the preview side. */}
              <div className="mt-5 [@container_(min-width:36rem)]:mt-auto [@container_(min-width:36rem)]:pt-5">
                {permissionGranted ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setJoinMeeting(true)}
                      className="h-11 w-full rounded-[10px] bg-gradient-to-b from-[#22C55E] to-[#16A34A] text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(2,6,23,0.4)] transition hover:from-[#2BD267] hover:to-[#18B04F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4ADE80]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0F172A]"
                    >
                      Join Classroom
                    </button>

                    <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-slate-400" role="status">
                      <CheckCircle2 size={13} className="text-emerald-400" aria-hidden="true" />
                      Camera and microphone access granted
                    </p>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={requestPermission}
                    disabled={checking}
                    className="flex h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-gradient-to-b from-[#3B82F6] to-[#2563EB] text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(2,6,23,0.4)] transition hover:from-[#4C8DF7] hover:to-[#2F6DEE] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0F172A] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {checking && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                    {checking ? "Checking devices..." : "Allow Camera & Microphone"}
                  </button>
                )}

                {error && (
                  <div
                    role="alert"
                    className="mt-3 flex items-start gap-2 rounded-[10px] border border-red-500/25 bg-red-500/[0.08] px-3 py-2.5 text-xs leading-snug text-red-200"
                  >
                    <AlertCircle size={14} className="mt-px shrink-0 text-red-400" aria-hidden="true" />
                    <span className="min-w-0">{error}</span>
                  </div>
                )}
              </div>
            </div>

          </div>
        </div>

      </div>

    </div>
  );
}
