"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type DeviceOption = {
  deviceId: string;
  label: string;
};

// How long we wait for a single browser media call (getUserMedia /
// enumerateDevices) before giving up on it. getUserMedia does not support
// AbortSignal in any of the browsers we support (Android WebView / Chrome,
// Safari, Firefox mobile all lack it as of this writing), so a real
// in-flight call cannot be cancelled — this timeout only stops us from
// waiting on it forever. If the browser call eventually does settle after
// we've moved on, `withTimeout` below releases whatever it produced instead
// of adopting it.
const DEVICE_REQUEST_TIMEOUT_MS = 15000;

/** Thrown locally when a browser media call doesn't settle within our timeout. */
class MediaTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

function getErrorName(err: unknown): string | undefined {
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

/**
 * Races `promise` against a timeout. Unlike a plain `Promise.race`, this
 * keeps listening to the original promise even after it has timed out —
 * getUserMedia() can't be cancelled, so if it finally resolves late (e.g.
 * the user answers a slow native permission prompt after we've already
 * given up), `onDiscarded` gets the result so the caller can release it
 * (stop any MediaStream tracks) instead of silently leaking an open
 * camera/microphone.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onDiscarded?: (value: T) => void
): Promise<T> {
  let timedOut = false;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new MediaTimeoutError(message));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        if (timedOut) {
          onDiscarded?.(value);
        } else {
          resolve(value);
        }
      },
      (err) => {
        clearTimeout(timer);
        if (!timedOut) {
          reject(err);
        }
      }
    );
  });
}

function toDeviceOptions(
  devices: MediaDeviceInfo[],
  kind: MediaDeviceKind,
  fallbackPrefix: string
): DeviceOption[] {
  return devices
    .filter((d) => d.kind === kind)
    .map((d, index) => ({
      deviceId: d.deviceId,
      // Labels are only populated once permission has actually been
      // granted; before that (or if the browser withholds them anyway)
      // fall back to a numbered placeholder instead of inventing hardware
      // names like "Front Camera" / "Back Camera".
      label: d.label || `${fallbackPrefix} ${index + 1}`,
    }));
}

function describeMediaError(err: unknown): string {
  if (err instanceof MediaTimeoutError) {
    return err.message;
  }

  switch (getErrorName(err)) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Camera or microphone permission was denied. Please allow access and try again.";

    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera or microphone was found on this device.";

    case "NotReadableError":
    case "TrackStartError":
      return "The camera or microphone is currently unavailable. Close other apps using it and try again.";

    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "The selected camera or microphone is no longer available. Please choose another device.";

    case "SecurityError":
      return "Camera and microphone access is blocked in this browser. Please check your browser or site settings.";

    case "AbortError":
      return "The camera or microphone request was interrupted. Please try again.";

    default:
      return "Something went wrong while accessing your camera or microphone. Please try again.";
  }
}

/**
 * Best-effort refinement of a NotFoundError into "no camera" vs. "no
 * microphone" vs. "neither", by checking which device kinds are present at
 * all. If this itself fails or times out, the caller falls back to the
 * combined message from describeMediaError.
 */
async function describeNotFoundError(): Promise<string> {
  try {
    const devices = await withTimeout(
      navigator.mediaDevices.enumerateDevices(),
      DEVICE_REQUEST_TIMEOUT_MS,
      ""
    );

    const hasCamera = devices.some((d) => d.kind === "videoinput");
    const hasMic = devices.some((d) => d.kind === "audioinput");

    if (!hasCamera && hasMic) return "No camera was found on this device.";
    if (hasCamera && !hasMic) return "No microphone was found on this device.";
  } catch {
    // Best-effort only — fall through to the combined message below.
  }

  return "No camera or microphone was found on this device.";
}

export default function useMediaDevices() {
  const videoRef = useRef<HTMLVideoElement>(null);

  const streamRef = useRef<MediaStream | null>(null);

  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(true);

  const [cameras, setCameras] = useState<DeviceOption[]>([]);
  const [microphones, setMicrophones] = useState<DeviceOption[]>([]);
  const [speakers, setSpeakers] = useState<DeviceOption[]>([]);

  const [selectedCamera, setSelectedCameraState] = useState("");
  const [selectedMicrophone, setSelectedMicrophoneState] = useState("");
  const [selectedSpeaker, setSelectedSpeaker] = useState("");

  const [permissionGranted, setPermissionGranted] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  // Reentrancy guard for requestPermission — the "Allow" button is already
  // disabled while `checking` is true, but this keeps the hook itself safe
  // to call defensively from anywhere.
  const checkingRef = useRef(false);

  // "Latest wins" guards for device switching: if the user flips a dropdown
  // again before the previous switch has settled, the stale switch's result
  // is discarded instead of racing the newer one for `streamRef.current`.
  const pendingCameraIdRef = useRef<string | null>(null);
  const pendingMicIdRef = useRef<string | null>(null);

  /**
   * Requests camera + microphone permission and detects hardware.
   *
   * This performs exactly ONE getUserMedia() call (plus one
   * enumerateDevices() call) for the whole initial permission flow — the
   * granted stream is adopted directly and the default camera/microphone
   * selection is read back from its own tracks, instead of picking "the
   * first device in the list" and re-acquiring a second stream to match it.
   */
  const requestPermission = useCallback(async () => {
    if (checkingRef.current) return;

    checkingRef.current = true;
    setChecking(true);
    setError("");

    let stream: MediaStream | null = null;

    try {
      stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ video: true, audio: true }),
        DEVICE_REQUEST_TIMEOUT_MS,
        "Checking your camera and microphone took too long. Please try again.",
        (lateStream) => lateStream.getTracks().forEach((track) => track.stop())
      );

      // Adopt the granted stream as-is — no second acquisition just to
      // "select" a device.
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      const devices = await withTimeout(
        navigator.mediaDevices.enumerateDevices(),
        DEVICE_REQUEST_TIMEOUT_MS,
        "Checking your camera and microphone took too long. Please try again."
      );

      const cameraList = toDeviceOptions(devices, "videoinput", "Camera");
      const micList = toDeviceOptions(devices, "audioinput", "Microphone");
      const speakerList = toDeviceOptions(devices, "audiooutput", "Speaker");

      setCameras(cameraList);
      setMicrophones(micList);
      setSpeakers(speakerList);

      // Default selection follows whatever device the browser actually
      // granted (read back from the live tracks), falling back to the
      // first enumerated device only if that can't be determined.
      const grantedCameraId = stream.getVideoTracks()[0]?.getSettings().deviceId;
      const grantedMicId = stream.getAudioTracks()[0]?.getSettings().deviceId;

      const initialCamera =
        (grantedCameraId && cameraList.some((c) => c.deviceId === grantedCameraId)
          ? grantedCameraId
          : cameraList[0]?.deviceId) ?? "";

      const initialMic =
        (grantedMicId && micList.some((m) => m.deviceId === grantedMicId)
          ? grantedMicId
          : micList[0]?.deviceId) ?? "";

      pendingCameraIdRef.current = initialCamera || null;
      pendingMicIdRef.current = initialMic || null;

      setSelectedCameraState(initialCamera);
      setSelectedMicrophoneState(initialMic);

      if (speakerList.length) {
        setSelectedSpeaker(speakerList[0].deviceId);
      }

      setPermissionGranted(true);
    } catch (err) {
      // Release anything this attempt acquired and reset to a clean slate
      // so the user can retry without refreshing the page.
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;

      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }

      console.error("[useMediaDevices] requestPermission failed:", err);

      const message =
        getErrorName(err) === "NotFoundError"
          ? await describeNotFoundError()
          : describeMediaError(err);

      setError(message);
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }, []);

  /** Swaps only the video track for `deviceId`, keeping the audio track running. */
  const switchCamera = useCallback(async (deviceId: string) => {
    if (!deviceId || !streamRef.current) return;

    pendingCameraIdRef.current = deviceId;

    try {
      const newStream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: deviceId } },
        }),
        DEVICE_REQUEST_TIMEOUT_MS,
        "Switching cameras took too long. Please try again.",
        (lateStream) => lateStream.getTracks().forEach((track) => track.stop())
      );

      const newVideoTrack = newStream.getVideoTracks()[0];

      if (pendingCameraIdRef.current !== deviceId || !newVideoTrack) {
        // Superseded by a newer selection while this was in flight, or the
        // device unexpectedly produced no video track.
        newStream.getTracks().forEach((track) => track.stop());
        return;
      }

      const previous = streamRef.current;
      const audioTracks = previous?.getAudioTracks() ?? [];
      const combined = new MediaStream([...audioTracks, newVideoTrack]);

      previous?.getVideoTracks().forEach((track) => track.stop());

      streamRef.current = combined;

      if (videoRef.current) {
        videoRef.current.srcObject = combined;
      }

      setCameraEnabled(newVideoTrack.enabled);
      setError("");
    } catch (err) {
      console.error("[useMediaDevices] switchCamera failed:", err);
      setError(describeMediaError(err));
    }
  }, []);

  /** Swaps only the audio track for `deviceId`, keeping the video track running. */
  const switchMicrophone = useCallback(async (deviceId: string) => {
    if (!deviceId || !streamRef.current) return;

    pendingMicIdRef.current = deviceId;

    try {
      const newStream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: deviceId } },
        }),
        DEVICE_REQUEST_TIMEOUT_MS,
        "Switching microphones took too long. Please try again.",
        (lateStream) => lateStream.getTracks().forEach((track) => track.stop())
      );

      const newAudioTrack = newStream.getAudioTracks()[0];

      if (pendingMicIdRef.current !== deviceId || !newAudioTrack) {
        newStream.getTracks().forEach((track) => track.stop());
        return;
      }

      const previous = streamRef.current;
      const videoTracks = previous?.getVideoTracks() ?? [];
      const combined = new MediaStream([...videoTracks, newAudioTrack]);

      previous?.getAudioTracks().forEach((track) => track.stop());

      streamRef.current = combined;

      if (videoRef.current) {
        videoRef.current.srcObject = combined;
      }

      setMicrophoneEnabled(newAudioTrack.enabled);
      setError("");
    } catch (err) {
      console.error("[useMediaDevices] switchMicrophone failed:", err);
      setError(describeMediaError(err));
    }
  }, []);

  /** Public setter for the camera dropdown: updates selection and (once
   *  permission is granted) triggers the actual track swap. */
  const setSelectedCamera = useCallback(
    (deviceId: string) => {
      setSelectedCameraState(deviceId);
      if (permissionGranted) {
        void switchCamera(deviceId);
      }
    },
    [permissionGranted, switchCamera]
  );

  /** Public setter for the microphone dropdown — mirrors setSelectedCamera. */
  const setSelectedMicrophone = useCallback(
    (deviceId: string) => {
      setSelectedMicrophoneState(deviceId);
      if (permissionGranted) {
        void switchMicrophone(deviceId);
      }
    },
    [permissionGranted, switchMicrophone]
  );

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
   * Keep the device lists (and selection) in sync with hardware that's
   * plugged in / unplugged while the preview is open. This only re-runs
   * enumerateDevices() — it never re-acquires a stream unless the
   * currently selected device actually disappeared, in which case it
   * falls back to whatever device is still available.
   */
  useEffect(() => {
    if (!permissionGranted) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.addEventListener) {
      return;
    }

    let cancelled = false;

    const handleDeviceChange = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();

        if (cancelled) return;

        const cameraList = toDeviceOptions(devices, "videoinput", "Camera");
        const micList = toDeviceOptions(devices, "audioinput", "Microphone");
        const speakerList = toDeviceOptions(devices, "audiooutput", "Speaker");

        setCameras(cameraList);
        setMicrophones(micList);
        setSpeakers(speakerList);

        const cameraStillPresent = cameraList.some(
          (c) => c.deviceId === pendingCameraIdRef.current
        );
        if (!cameraStillPresent) {
          const fallback = cameraList[0]?.deviceId ?? "";
          setSelectedCameraState(fallback);
          pendingCameraIdRef.current = fallback || null;
          if (fallback) void switchCamera(fallback);
        }

        const micStillPresent = micList.some(
          (m) => m.deviceId === pendingMicIdRef.current
        );
        if (!micStillPresent) {
          const fallback = micList[0]?.deviceId ?? "";
          setSelectedMicrophoneState(fallback);
          pendingMicIdRef.current = fallback || null;
          if (fallback) void switchMicrophone(fallback);
        }

        setSelectedSpeaker((current) =>
          current && speakerList.some((s) => s.deviceId === current)
            ? current
            : (speakerList[0]?.deviceId ?? "")
        );
      } catch (err) {
        console.error("[useMediaDevices] Failed to refresh devices after devicechange:", err);
      }
    };

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [permissionGranted, switchCamera, switchMicrophone]);

  /**
   * Cleanup: stop every track on unmount so a closed/abandoned device-setup
   * screen never leaves the camera or microphone running.
   */
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
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
