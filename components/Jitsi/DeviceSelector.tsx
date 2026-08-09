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
  return (
    <div className="space-y-5">

      {/* Camera */}
      <div>
        <label className="mb-2 block text-sm font-medium text-slate-700">
          Camera
        </label>

        <select
          value={selectedCamera}
          onChange={(e) => onCameraChange(e.target.value)}
          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 focus:border-blue-500 focus:outline-none"
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
        <label className="mb-2 block text-sm font-medium text-slate-700">
          Microphone
        </label>

        <select
          value={selectedMicrophone}
          onChange={(e) => onMicrophoneChange(e.target.value)}
          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 focus:border-blue-500 focus:outline-none"
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
        <label className="mb-2 block text-sm font-medium text-slate-700">
          Speaker
        </label>

        <select
          value={selectedSpeaker}
          onChange={(e) => onSpeakerChange(e.target.value)}
          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 focus:border-blue-500 focus:outline-none"
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