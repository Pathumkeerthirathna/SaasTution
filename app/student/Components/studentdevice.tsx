"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Smartphone,
  Monitor,
  Tablet,
  CheckCircle2,
  XCircle,
  Clock3,
  Pencil,
  Save,
  X,
  Globe,
  MapPin,
  Cpu,
  LogIn,
  MonitorSmartphone,
  MoreVertical,
  ChevronDown,
} from "lucide-react";
import toast from "react-hot-toast";
import { StudentDeviceStatus } from "@prisma/client";

import type { DeviceRow } from "@/app/dashboard/students/[id]/page";

type StudentDevice = DeviceRow;

interface StudentDevicesProps {
  studentId: string;
  /** When provided by the parent page, the tab renders this instead of fetching. */
  data?: StudentDevice[] | null;
  /** Called after approve / reject / response edits so the parent can refresh. */
  onChanged?: () => void;
}

const STATUS_THEME = {
  APPROVED: {
    accent: "border-t-emerald-400",
    tile: "bg-emerald-50 text-emerald-600",
    pill: "bg-emerald-100 text-emerald-700",
    icon: <CheckCircle2 size={11} />,
    label: "Approved",
  },
  BLOCKED: {
    accent: "border-t-rose-400",
    tile: "bg-rose-50 text-rose-600",
    pill: "bg-rose-100 text-rose-700",
    icon: <XCircle size={11} />,
    label: "Blocked",
  },
  PENDING: {
    accent: "border-t-amber-400",
    tile: "bg-amber-50 text-amber-600",
    pill: "bg-amber-100 text-amber-700",
    icon: <Clock3 size={11} />,
    label: "Pending",
  },
} as const;

function themeFor(status: StudentDevice["status"]) {
  return STATUS_THEME[status] ?? STATUS_THEME.PENDING;
}

function fmt(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function deviceKind(device: StudentDevice): "tablet" | "phone" | "desktop" {
  const haystack = `${device.platform ?? ""} ${device.os ?? ""} ${
    device.deviceModel ?? ""
  } ${device.deviceName ?? ""} ${device.userAgent ?? ""}`.toLowerCase();

  if (/ipad|tablet/.test(haystack)) return "tablet";
  if (/android|iphone|ios|mobile|pixel|galaxy/.test(haystack)) return "phone";
  return "desktop";
}

function DeviceGlyph({
  device,
  className,
}: {
  device: StudentDevice;
  className?: string;
}) {
  const kind = deviceKind(device);
  if (kind === "tablet") return <Tablet className={className} />;
  if (kind === "phone") return <Smartphone className={className} />;
  return <Monitor className={className} />;
}

export function StudentDevices({
  studentId,
  data,
  onChanged,
}: StudentDevicesProps) {
  const controlled = data !== undefined;

  const [fetched, setFetched] = useState<StudentDevice[] | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [teacherResponse, setTeacherResponse] = useState("");

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/student/Profile/${studentId}/devices`
      );
      const result = await response.json();
      setFetched(result.success ? (result.data as StudentDevice[]) : []);
    } catch (error) {
      console.error(error);
      setFetched([]);
    }
  }, [studentId]);

  useEffect(() => {
    if (controlled) return;
    void loadDevices();
  }, [controlled, loadDevices]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuId(null);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const refresh = useCallback(async () => {
    if (controlled) {
      onChanged?.();
    } else {
      await loadDevices();
    }
  }, [controlled, onChanged, loadDevices]);

  const devices = (controlled ? data : fetched) ?? [];
  const loading = (controlled ? data : fetched) == null;

  async function mutate(
    deviceId: string,
    path: string,
    successMsg: string,
    failMsg: string
  ) {
    try {
      setProcessingId(deviceId);
      setMenuId(null);
      const response = await fetch(
        `/api/student/devices/${deviceId}/${path}`,
        { method: "PUT" }
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.message);
      toast.success(result.message ?? successMsg);
      await refresh();
    } catch (error) {
      console.error(error);
      toast.error(failMsg);
    } finally {
      setProcessingId(null);
    }
  }

  const handleApprove = (id: string) =>
    mutate(id, "approve", "Device approved.", "Unable to approve device.");
  const handleReject = (id: string) =>
    mutate(id, "reject", "Device rejected.", "Unable to reject device.");

  function startEdit(device: StudentDevice) {
    setMenuId(null);
    setExpandedId(device.id);
    setEditingDeviceId(device.id);
    setTeacherResponse(device.rejectedReason ?? "");
  }

  function cancelEdit() {
    setEditingDeviceId(null);
    setTeacherResponse("");
  }

  async function saveTeacherResponse(deviceId: string) {
    try {
      setProcessingId(deviceId);
      const response = await fetch(
        `/api/student/devices/${deviceId}/teacher-response`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rejectedReason: teacherResponse }),
        }
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.message);
      toast.success("Teacher response updated.");
      setEditingDeviceId(null);
      await refresh();
    } catch (error) {
      console.error(error);
      toast.error("Unable to update response.");
    } finally {
      setProcessingId(null);
    }
  }

  if (loading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="animate-pulse rounded-xl border border-slate-200 border-t-2 border-t-slate-200 bg-white p-3 shadow-sm"
          >
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-lg bg-slate-100" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-28 rounded bg-slate-200" />
                <div className="h-2.5 w-36 rounded bg-slate-100" />
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {[0, 1, 2, 3].map((x) => (
                <div key={x} className="h-3 rounded bg-slate-100" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
        <MonitorSmartphone className="mx-auto mb-2 h-8 w-8 text-slate-400" />
        <h3 className="text-[13px] font-semibold text-slate-900">
          No devices found
        </h3>
        <p className="mt-1 text-[12px] text-slate-500">
          This student has not attempted to sign in from any device yet.
        </p>
      </div>
    );
  }

  return (
    <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {devices.map((device) => {
        const theme = themeFor(device.status);
        const busy = processingId === device.id;
        const expanded = expandedId === device.id;

        return (
          <div
            key={device.id}
            className={`rounded-xl border border-slate-200 border-t-2 bg-white shadow-sm transition-shadow hover:shadow-md ${theme.accent}`}
          >
            {/* Header */}
            <div className="flex items-start gap-2 p-3">
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${theme.tile}`}
              >
                <DeviceGlyph device={device} className="h-[18px] w-[18px]" />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <h3 className="truncate text-[13px] font-bold leading-tight text-slate-900">
                    {device.deviceName ??
                      device.deviceModel ??
                      "Unknown Device"}
                  </h3>
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${theme.pill}`}
                  >
                    {theme.icon}
                    {theme.label}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[10px] text-slate-500">
                  {device.browser ?? "Unknown"}
                  {device.browserVersion ? ` ${device.browserVersion}` : ""}
                  {" · "}
                  {device.os ?? "Unknown OS"}
                  {device.osVersion ? ` ${device.osVersion}` : ""}
                </p>
              </div>

              {/* Kebab menu */}
              <div className="relative shrink-0" ref={menuId === device.id ? menuRef : undefined}>
                <button
                  type="button"
                  onClick={() =>
                    setMenuId((cur) => (cur === device.id ? null : device.id))
                  }
                  disabled={busy}
                  className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
                >
                  <MoreVertical size={15} />
                </button>

                {menuId === device.id && (
                  <div className="absolute right-0 top-full z-20 mt-1 w-36 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-[11px] shadow-lg">
                    {device.status === "PENDING" && (
                      <>
                        <MenuItem onClick={() => void handleApprove(device.id)}>
                          Approve
                        </MenuItem>
                        <MenuItem
                          tone="danger"
                          onClick={() => void handleReject(device.id)}
                        >
                          Reject
                        </MenuItem>
                      </>
                    )}
                    {device.status === "APPROVED" && (
                      <MenuItem
                        tone="danger"
                        onClick={() => void handleReject(device.id)}
                      >
                        Block device
                      </MenuItem>
                    )}
                    {device.status === "BLOCKED" && (
                      <>
                        <MenuItem onClick={() => void handleApprove(device.id)}>
                          Accept device
                        </MenuItem>
                        <MenuItem onClick={() => startEdit(device)}>
                          Edit response
                        </MenuItem>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Detail tiles */}
            <div className="divide-y divide-slate-100 border-t border-slate-100 px-3">
              <DetailRow icon={<Cpu size={12} />} label="Platform">
                {device.platform ?? "—"}
              </DetailRow>
              <DetailRow icon={<Globe size={12} />} label="IP Address">
                {device.lastIpAddress ?? "—"}
              </DetailRow>
              <DetailRow icon={<LogIn size={12} />} label="First Login">
                {fmt(device.firstLoginAt)}
              </DetailRow>
              <DetailRow icon={<Clock3 size={12} />} label="Last Login">
                {device.lastLoginAt ? fmt(device.lastLoginAt) : "Never"}
              </DetailRow>

              {expanded && (
                <>
                  <DetailRow icon={<Cpu size={12} />} label="Model">
                    {device.deviceModel ?? "—"}
                  </DetailRow>
                  <DetailRow icon={<MapPin size={12} />} label="Location">
                    {device.city ?? "—"}
                    {device.country ? `, ${device.country}` : ""}
                  </DetailRow>
                  {(device.status === "APPROVED" ||
                    device.status === "BLOCKED") && (
                    <>
                      <DetailRow icon={<CheckCircle2 size={12} />} label="Actioned by">
                        {device.approvedByTeacher?.fullName ?? "—"}
                      </DetailRow>
                      <DetailRow icon={<Clock3 size={12} />} label="Actioned on">
                        {device.status === "APPROVED"
                          ? fmt(device.approvedAt)
                          : fmt(device.rejectedAt)}
                      </DetailRow>
                    </>
                  )}
                </>
              )}
            </div>

            {/* Student request (expanded) */}
            {expanded && device.approvalRequestMessage && (
              <div className="mx-3 mt-2 rounded-md border border-blue-100 bg-blue-50/70 px-2.5 py-1.5">
                <p className="text-[9px] font-semibold uppercase tracking-wide text-blue-700">
                  Student request
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-[11px] leading-4 text-slate-700">
                  {device.approvalRequestMessage}
                </p>
              </div>
            )}

            {/* Teacher response */}
            {device.status === StudentDeviceStatus.BLOCKED && (
              <div className="mx-3 mt-2 rounded-md border border-rose-100 bg-rose-50/70 px-2.5 py-1.5">
                <div className="flex items-center justify-between">
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-rose-700">
                    Teacher response
                  </p>
                  {editingDeviceId !== device.id && (
                    <button
                      type="button"
                      onClick={() => startEdit(device)}
                      className="rounded p-0.5 text-slate-400 transition hover:bg-white hover:text-teal-700"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {editingDeviceId === device.id ? (
                  <>
                    <textarea
                      rows={2}
                      value={teacherResponse}
                      onChange={(e) => setTeacherResponse(e.target.value)}
                      className="mt-1 w-full rounded-md border border-slate-300 bg-white p-1.5 text-[11px] focus:border-teal-500 focus:outline-none"
                    />
                    <div className="mt-1.5 flex justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-0.5 text-[10px] font-medium text-slate-600"
                      >
                        <X className="h-3 w-3" />
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => saveTeacherResponse(device.id)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 rounded-md bg-teal-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
                      >
                        <Save className="h-3 w-3" />
                        Save
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="mt-0.5 whitespace-pre-wrap text-[11px] leading-4 text-slate-700">
                    {device.rejectedReason ?? "No response provided."}
                  </p>
                )}
              </div>
            )}

            {/* Footer */}
            <div className="mt-2 flex items-center justify-between border-t border-slate-100 px-3 py-2">
              <span className="truncate text-[10px] text-slate-400">
                {device.approvalRequestedAt
                  ? `Requested ${fmt(device.approvalRequestedAt)}`
                  : `Seen ${fmt(device.firstLoginAt)}`}
              </span>

              <button
                type="button"
                onClick={() =>
                  setExpandedId((cur) => (cur === device.id ? null : device.id))
                }
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600 transition hover:bg-slate-50"
              >
                {expanded ? "Hide details" : "View Details"}
                <ChevronDown
                  size={11}
                  className={`transition-transform ${expanded ? "rotate-180" : ""}`}
                />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DetailRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
        <span className="text-slate-400">{icon}</span>
        {label}
      </span>
      <span className="truncate text-right text-[11px] font-semibold text-slate-800">
        {children}
      </span>
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left font-medium transition hover:bg-slate-50 ${
        tone === "danger" ? "text-rose-600" : "text-slate-700"
      }`}
    >
      {children}
    </button>
  );
}
