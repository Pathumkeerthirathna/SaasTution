"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Smartphone,
  Monitor,
  CheckCircle2,
  XCircle,
  Clock3,
  Pencil,
  Save,
  X,
} from "lucide-react";
import toast from "react-hot-toast";
import { StudentDeviceStatus } from "@prisma/client";

interface StudentDevice {
  id: string;

  deviceId: string;

  deviceName: string | null;
  deviceModel: string | null;

  browser: string | null;
  browserVersion: string | null;

  os: string | null;
  osVersion: string | null;

  platform: string | null;

  userAgent: string | null;

  lastIpAddress: string | null;

  country: string | null;
  city: string | null;

  status: "PENDING" | "APPROVED" | "BLOCKED";

  firstLoginAt: string;
  lastLoginAt: string | null;

  approvalRequestedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;

  approvedReason: string | null;
  rejectedReason: string | null;

  approvedByTeacher: {
    id: string;
    fullName: string;
  } | null;
  approvalRequestMessage: string | null;

  
}

interface StudentDevicesProps {
  studentId: string;
}

export function StudentDevices({
  studentId,
}: StudentDevicesProps) {
  const [devices, setDevices] = useState<StudentDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [teacherResponse, setTeacherResponse] = useState("");

  const loadDevices = useCallback(async () => {
    if (!studentId) return;

    try {
      setLoading(true);

      const response = await fetch(
        `/api/student/Profile/${studentId}/devices`
      );

      console.log(response);

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message);
      }

      console.log(result.data);

      if (result.success) {
        setDevices(result.data);
      }
    } catch (error) {
      console.error(error);

      toast.error("Failed to load student devices.");
    } finally {
      setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  async function handleApprove(deviceId: string) {
    try {
      setProcessingId(deviceId);

      const response = await fetch(
        `/api/student/devices/${deviceId}/approve`,
        {
          method: "PUT",
        }
      );

      const result = await response.json();

      console.log(result);

      if (!response.ok) {
        throw new Error(result.message);
      }

      toast.success(result.message ?? "Device approved.");

      await loadDevices();
    } catch (error) {
      console.error(error);

      toast.error("Unable to approve device.");
    } finally {
      setProcessingId(null);
    }
  }

  async function handleReject(deviceId: string) {
    try {
      setProcessingId(deviceId);

      const response = await fetch(
        `/api/student/devices/${deviceId}/reject`,
        {
          method: "PUT",
        }
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message);
      }

      toast.success(result.message ?? "Device rejected.");

      await loadDevices();
    } catch (error) {
      console.error(error);

      toast.error("Unable to reject device.");
    } finally {
      setProcessingId(null);
    }
  }

  function getStatusBadge(status: StudentDevice["status"]) {
    switch (status) {
      case "APPROVED":
        return (
          <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
            <CheckCircle2 size={14} />
            Approved
          </span>
        );

      case "BLOCKED":
        return (
          <span className="flex items-center gap-1 rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-700">
            <XCircle size={14} />
            Rejected
          </span>
        );

      default:
        return (
          <span className="flex items-center gap-1 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
            <Clock3 size={14} />
            Pending
          </span>
        );
    }
  }

  function startEdit(device: StudentDevice) {
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
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            rejectedReason: teacherResponse,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message);
      }

      toast.success("Teacher response updated.");

      setEditingDeviceId(null);

      await loadDevices();
    } catch (error) {
      console.error(error);
      toast.error("Unable to update response.");
    } finally {
      setProcessingId(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-5">
        {[1, 2, 3].map((item) => (
          <div
            key={item}
            className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
          >
            <div className="animate-pulse">
              <div className="flex justify-between">
                <div>
                  <div className="h-5 w-56 rounded bg-slate-200" />
                  <div className="mt-3 h-4 w-40 rounded bg-slate-100" />
                </div>

                <div className="h-8 w-24 rounded-full bg-slate-200" />
              </div>

              <div className="mt-6 grid gap-5 md:grid-cols-3">
                {[1, 2, 3, 4, 5, 6].map((x) => (
                  <div key={x}>
                    <div className="h-3 w-20 rounded bg-slate-200" />
                    <div className="mt-2 h-4 w-32 rounded bg-slate-100" />
                  </div>
                ))}
              </div>

              <div className="mt-6 flex gap-3">
                <div className="h-10 w-28 rounded-lg bg-slate-200" />
                <div className="h-10 w-28 rounded-lg bg-slate-200" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!loading && devices.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
        <Smartphone className="mx-auto mb-3 h-10 w-10 text-slate-400" />

        <h3 className="text-sm font-medium text-slate-900">
          No devices found
        </h3>

        <p className="mt-2 text-sm text-slate-500">
          This student has not attempted to sign in from any device yet.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
        {devices.map((device) => (
            <div
            key={device.id}
            className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md"
            >
            {/* Header */}
            <div className="border-b border-slate-100 bg-slate-50 px-6 py-4">
                <div className="flex items-center justify-between">
                <div>
                    <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
                    <Monitor className="h-5 w-5 text-blue-600" />

                    {device.deviceName ??
                        device.deviceModel ??
                        "Unknown Device"}
                    </h3>

                    <p className="mt-1 text-sm text-slate-500">
                    {device.browser ?? "Unknown Browser"}
                    {device.browserVersion
                        ? ` ${device.browserVersion}`
                        : ""}
                    {" • "}
                    {device.os ?? "Unknown OS"}
                    {device.osVersion ? ` ${device.osVersion}` : ""}
                    </p>
                </div>

                {getStatusBadge(device.status)}
                </div>
            </div>

            {/* Device Details */}
            <div className="grid gap-5 p-6 md:grid-cols-3">
                <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                    Device Model
                </p>

                <p className="mt-2 text-sm font-medium">
                    {device.deviceModel ?? "-"}
                </p>
                </div>

                <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                    Browser
                </p>

                <p className="mt-2 text-sm font-medium">
                    {device.browser ?? "-"}
                    {device.browserVersion
                    ? ` ${device.browserVersion}`
                    : ""}
                </p>
                </div>

                <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                    Operating System
                </p>

                <p className="mt-2 text-sm font-medium">
                    {device.os ?? "-"}
                    {device.osVersion ? ` ${device.osVersion}` : ""}
                </p>
                </div>

                <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                    Platform
                </p>

                <p className="mt-2 text-sm font-medium">
                    {device.platform ?? "-"}
                </p>
                </div>

                <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                    IP Address
                </p>

                <p className="mt-2 text-sm font-medium">
                    {device.lastIpAddress ?? "-"}
                </p>
                </div>

                <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                    Location
                </p>

                <p className="mt-2 text-sm font-medium">
                    {device.city ?? "-"}
                    {device.country
                    ? `, ${device.country}`
                    : ""}
                </p>
                </div>

                <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                    First Login
                </p>

                <p className="mt-2 text-sm font-medium">
                    {new Date(
                    device.firstLoginAt
                    ).toLocaleString()}
                </p>
                </div>

                <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                    Last Login
                </p>

                <p className="mt-2 text-sm font-medium">
                    {device.lastLoginAt
                    ? new Date(
                        device.lastLoginAt
                        ).toLocaleString()
                    : "Never"}
                </p>
                </div>

                <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                    Requested
                </p>

                <p className="mt-2 text-sm font-medium">
                    {device.approvalRequestedAt
                    ? new Date(
                        device.approvalRequestedAt
                        ).toLocaleString()
                    : "-"}
                </p>
                </div>
            </div>

            {device.approvalRequestMessage && (
              <div className="border-t border-slate-100 px-6 py-5">

                <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">

                  <div className="flex items-center gap-2">

                    <span className="text-lg">📝</span>

                    <h4 className="font-semibold text-slate-900">
                      Student Request
                    </h4>

                  </div>

                  <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                    {device.approvalRequestMessage}
                  </p>

                </div>

              </div>
            )}

            {device.status === StudentDeviceStatus.BLOCKED && (
              <div className="border-t border-slate-100 px-6 py-5">

                <div className="rounded-xl border border-red-200 bg-red-50 p-4">

                  <div className="mb-4 flex items-center justify-between">

                    <div className="flex items-center gap-2">

                      <span className="text-lg">💬</span>

                      <h4 className="font-semibold text-slate-900">
                        Teacher Response
                      </h4>

                    </div>

                    {editingDeviceId !== device.id && (
                      <button
                        onClick={() => startEdit(device)}
                        className="rounded-lg p-2 text-slate-500 transition hover:bg-white hover:text-blue-600"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                    )}

                  </div>

                  {editingDeviceId === device.id ? (

                    <>
                      <textarea
                        rows={4}
                        value={teacherResponse}
                        onChange={(e) => setTeacherResponse(e.target.value)}
                        className="w-full rounded-xl border border-slate-300 bg-white p-3 text-sm focus:border-blue-500 focus:outline-none"
                      />

                      <div className="mt-4 flex justify-end gap-3">

                        <button
                          onClick={cancelEdit}
                          className="rounded-lg border border-slate-300 px-4 py-2 text-sm"
                        >
                          <X className="mr-1 inline h-4 w-4" />
                          Cancel
                        </button>

                        <button
                          onClick={() => saveTeacherResponse(device.id)}
                          disabled={processingId === device.id}
                          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                        >
                          <Save className="mr-1 inline h-4 w-4" />
                          Save
                        </button>

                      </div>

                    </>

                  ) : (

                    <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">
                      {device.rejectedReason ?? "No response provided."}
                    </p>

                  )}

                </div>

              </div>
            )}

            

            {/* Approval Information */}
            {(device.status === "APPROVED" ||
                device.status === "BLOCKED") && (
                <div className="border-t border-slate-100 px-6 py-5">
                <div className="grid gap-5 md:grid-cols-3">
                    <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">
                        Approved By
                    </p>

                    <p className="mt-2 text-sm font-medium">
                        {device.approvedByTeacher?.fullName ??
                        "-"}
                    </p>
                    </div>

                    <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">
                        Approved Date
                    </p>

                    <p className="mt-2 text-sm font-medium">
                        {device.approvedAt
                        ? new Date(
                            device.approvedAt
                            ).toLocaleString()
                        : "-"}
                    </p>
                    </div>

                    <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">
                        Reason
                    </p>

                    <p className="mt-2 text-sm font-medium">
                        {device.status === "APPROVED"
                        ? device.approvedReason ?? "-"
                        : device.rejectedReason ?? "-"}
                    </p>
                    </div>
                </div>
                </div>
            )}

            {/* Footer */}
            {/* Footer */}
            <div className="flex justify-end gap-3 border-t border-slate-100 bg-slate-50 px-6 py-4">
              {device.status === "PENDING" && (
                <>
                  <button
                    disabled={processingId === device.id}
                    onClick={() => handleReject(device.id)}
                    className="rounded-lg border border-red-200 bg-red-50 px-5 py-2 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-60"
                  >
                    Reject
                  </button>

                  <button
                    disabled={processingId === device.id}
                    onClick={() => handleApprove(device.id)}
                    className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
                  >
                    Approve
                  </button>
                </>
              )}

              {device.status === "APPROVED" && (
                <button
                  disabled={processingId === device.id}
                  onClick={() => handleReject(device.id)}
                  className="rounded-lg border border-red-200 bg-red-50 px-5 py-2 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-60"
                >
                  Block
                </button>
              )}

              {device.status === "BLOCKED" && (
                <button
                  disabled={processingId === device.id}
                  onClick={() => handleApprove(device.id)}
                  className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
                >
                  Accept
                </button>
              )}
            </div>
            </div>
        ))}
        </div>
  );
}