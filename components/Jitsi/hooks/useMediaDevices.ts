"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type DeviceOption = {
  deviceId: string;
  label: string;
};

export default function useMediaDevices() {
  const videoRef = useRef<HTMLVideoElement>(null);

  const streamRef = useRef<MediaStream | null>(null);

  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(true);

  const [cameras, setCameras] = useState<DeviceOption[]>([]);
  const [microphones, setMicrophones] = useState<DeviceOption[]>([]);
  const [speakers, setSpeakers] = useState<DeviceOption[]>([]);

  const [selectedCamera, setSelectedCamera] = useState("");
  const [selectedMicrophone, setSelectedMicrophone] = useState("");
  const [selectedSpeaker, setSelectedSpeaker] = useState("");

  const [permissionGranted, setPermissionGranted] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  /**
   * Start preview using selected devices
   */
  const startPreview = useCallback(
    async (
      cameraId?: string,
      microphoneId?: string
    ) => {
      if (streamRef.current) {
        streamRef.current
          .getTracks()
          .forEach((track) => track.stop());
      }

      const stream =
        await navigator.mediaDevices.getUserMedia({
          video: cameraId
            ? {
                deviceId: {
                  exact: cameraId,
                },
              }
            : true,

          audio: microphoneId
            ? {
                deviceId: {
                  exact: microphoneId,
                },
              }
            : true,
        });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    },
    []
  );

  /**
   * Request permissions
   */
  const requestPermission = useCallback(async () => {
    try {
      setChecking(true);
      setError("");

      await startPreview();

      const devices =
        await navigator.mediaDevices.enumerateDevices();

      const cameraList = devices
        .filter((d) => d.kind === "videoinput")
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || "Camera",
        }));

      const micList = devices
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || "Microphone",
        }));

      const speakerList = devices
        .filter((d) => d.kind === "audiooutput")
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || "Speaker",
        }));

      setCameras(cameraList);
      setMicrophones(micList);
      setSpeakers(speakerList);

      if (cameraList.length) {
        setSelectedCamera(cameraList[0].deviceId);
      }

      if (micList.length) {
        setSelectedMicrophone(micList[0].deviceId);
      }

      if (speakerList.length) {
        setSelectedSpeaker(speakerList[0].deviceId);
      }

      setPermissionGranted(true);
    } catch {
      setError(
        "Camera or microphone permission was denied."
      );
    } finally {
      setChecking(false);
    }
  }, [startPreview]);

  function toggleCamera() {
  if (!streamRef.current) return;

  const track = streamRef.current.getVideoTracks()[0];

  if (!track) return;

  track.enabled = !track.enabled;

  setCameraEnabled(track.enabled);
}

function toggleMicrophone() {
  if (!streamRef.current) return;

  const track = streamRef.current.getAudioTracks()[0];

  if (!track) return;

  track.enabled = !track.enabled;

  setMicrophoneEnabled(track.enabled);
}

  /**
   * Restart preview when camera changes
   */
  useEffect(() => {
    if (!permissionGranted) return;

    startPreview(
      selectedCamera,
      selectedMicrophone
    );
  }, [
    selectedCamera,
    selectedMicrophone,
    permissionGranted,
    startPreview,
  ]);

  /**
   * Cleanup
   */
  useEffect(() => {
    return () => {
      streamRef.current
        ?.getTracks()
        .forEach((t) => t.stop());
    };
  }, []);

  return {
    stream: streamRef.current,
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
};
}