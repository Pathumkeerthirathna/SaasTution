"use client";

import { useId } from "react";
import { Camera, ChevronDown, Mic, Volume2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

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

  /**
   * Devices (and their labels) are only listed once the browser has granted
   * access. Until then each list is empty and says why, instead of inventing
   * device names.
   */
  permissionGranted?: boolean;
};

type FieldProps = {
  label: string;
  icon: LucideIcon;
  devices: MediaDeviceOption[];
  value: string;
  onChange: (value: string) => void;
  /** What an empty list says (no device is ever made up). */
  emptyText: string;
};

function DeviceField({ label, icon: Icon, devices, value, onChange, emptyText }: FieldProps) {
  const id = useId();
  const empty = devices.length === 0;

  return (
    <div className="min-w-0">
      <label
        htmlFor={id}
        className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-400"
      >
        <Icon size={13} aria-hidden="true" className="text-slate-500" />
        {label}
      </label>

      <div className="relative">
        <select
          id={id}
          value={empty ? "" : value}
          onChange={(e) => onChange(e.target.value)}
          disabled={empty}
          className="h-10 w-full min-w-0 appearance-none truncate rounded-[10px] border border-white/[0.08] bg-[#131C2E] pl-3 pr-9 text-sm text-slate-100 transition-colors hover:border-white/[0.14] focus:border-[#3B82F6] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3B82F6]/40 disabled:cursor-not-allowed disabled:text-slate-500 disabled:hover:border-white/[0.08] [@media(pointer:coarse)]:h-11"
        >
          {empty ? (
            <option value="">{emptyText}</option>
          ) : (
            devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))
          )}
        </select>

        <ChevronDown
          size={16}
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500"
        />
      </div>
    </div>
  );
}

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
  permissionGranted = false,
}: DeviceSelectorProps) {
  const beforeAccess = "Allow access to list devices";

  return (
    <div className="space-y-3.5">
      <DeviceField
        label="Camera"
        icon={Camera}
        devices={cameras}
        value={selectedCamera}
        onChange={onCameraChange}
        emptyText={permissionGranted ? "No camera found" : beforeAccess}
      />

      <DeviceField
        label="Microphone"
        icon={Mic}
        devices={microphones}
        value={selectedMicrophone}
        onChange={onMicrophoneChange}
        emptyText={permissionGranted ? "No microphone found" : beforeAccess}
      />

      <DeviceField
        label="Speaker"
        icon={Volume2}
        devices={speakers}
        value={selectedSpeaker}
        onChange={onSpeakerChange}
        // Some browsers (e.g. Safari, Firefox) never list speakers: the
        // system's default output is used.
        emptyText={permissionGranted ? "System default speaker" : beforeAccess}
      />
    </div>
  );
}
