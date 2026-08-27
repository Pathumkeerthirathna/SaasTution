"use client";

type MediaDeviceOption = {
  deviceId: string;
  label: string;
};

type DeviceSelectorProps = {
  cameras: MediaDeviceOption[];
  microphones: MediaDeviceOption[];
  speakers: MediaDeviceOption[];

  selectedCamera: string;
  selectedMicrophone: string;
  selectedSpeaker: string;

  onCameraChange: (value: string) => void;
  onMicrophoneChange: (value: string) => void;
  onSpeakerChange: (value: string) => void;
};

export default function DeviceSelector({
  cameras,
  microphones,
  speakers,
  selectedCamera,
  selectedMicrophone,
  selectedSpeaker,
  onCameraChange,
  onMicrophoneChange,
  onSpeakerChange,
}: DeviceSelectorProps) {
  const selectClassName =
    "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none";

  const labelClassName =
    "mb-1.5 block text-xs font-medium text-slate-400";

  return (
    <div className="space-y-4">

      {/* Camera */}
      <div>
        <label className={labelClassName}>
          Camera
        </label>

        <select
          value={selectedCamera}
          onChange={(e) => onCameraChange(e.target.value)}
          className={selectClassName}
        >
          {cameras.map((camera) => (
            <option
              key={camera.deviceId}
              value={camera.deviceId}
            >
              {camera.label}
            </option>
          ))}
        </select>
      </div>

      {/* Microphone */}
      <div>
        <label className={labelClassName}>
          Microphone
        </label>

        <select
          value={selectedMicrophone}
          onChange={(e) => onMicrophoneChange(e.target.value)}
          className={selectClassName}
        >
          {microphones.map((mic) => (
            <option
              key={mic.deviceId}
              value={mic.deviceId}
            >
              {mic.label}
            </option>
          ))}
        </select>
      </div>

      {/* Speaker */}
      <div>
        <label className={labelClassName}>
          Speaker
        </label>

        <select
          value={selectedSpeaker}
          onChange={(e) => onSpeakerChange(e.target.value)}
          className={selectClassName}
        >
          {speakers.map((speaker) => (
            <option
              key={speaker.deviceId}
              value={speaker.deviceId}
            >
              {speaker.label}
            </option>
          ))}
        </select>
      </div>

    </div>
  );
}