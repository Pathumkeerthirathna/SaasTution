"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Monitor,
  Smartphone,
  Tablet,
  Clock3,
  Cpu,
  Globe,
  LogIn,
  MapPin,
  MonitorSmartphone,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  RefreshCw,
  MessageSquare,
  User,
} from "lucide-react";
import toast from "react-hot-toast";

type TabKey = "pending" | "rejected";

type ApprovalDevice = {
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
  approvalRequestedByStudentAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  approvedReason: string | null;
  rejectedReason: string | null;
  approvalRequestMessage: string | null;
  approvedByTeacher: { id: string; fullName: string } | null;
  student: {
    id: string;
    name: string;
    registrationNumber: string | null;
    contact: string | null;
  };
};

type ApiPayload = {
  success: boolean;
  data?: { devices: ApprovalDevice[]; pendingCount: number };
  error?: { message?: string };
};

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

function deviceKind(device: ApprovalDevice): "tablet" | "phone" | "desktop" {
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
  device: ApprovalDevice;
  className?: string;
}) {
  const kind = deviceKind(device);
  if (kind === "tablet") return <Tablet className={className} />;
  if (kind === "phone") return <Smartphone className={className} />;
  return <Monitor className={className} />;
}

export function StudentDeviceApprovalsPanel() {
  const [tab, setTab] = useState<TabKey>("pending");
  const [devices, setDevices] = useState<ApprovalDevice[] | null>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (which: TabKey, opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setDevices(null);
      setError(null);
      setRefreshing(true);

      try {
        const res = await fetch(
          `/api/teacher/device-approvals?status=${which}`,
          { cache: "no-store" }
        );
        const body = (await res.json()) as ApiPayload;

        if (!res.ok || !body.success || !body.data) {
          throw new Error(body.error?.message ?? "Failed to load device approvals.");
        }

        setDevices(body.data.devices);
        setPendingCount(body.data.pendingCount);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load device approvals.");
        setDevices([]);
      } finally {
        setRefreshing(false);
      }
    },
    []
  );

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  const list = devices ?? [];
  const loading = devices === null;

  return (
    <div className="w-full space-y-4">
      {/* Header */}
      <div className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
        <div className="flex flex-col gap-3 border-b border-brand-100 bg-gradient-to-r from-brand-50 to-white px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-100 text-brand-700">
              <ShieldCheck size={18} />
            </div>
            <div>
              <h1 className="text-[15px] font-bold text-foreground">
                Student Device Approvals
              </h1>
              <p className="mt-0.5 text-xs text-muted">
                Review the devices your students want to sign in from. Confirm or
                reject each request, and reply to the student if you need to.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void load(tab, { silent: true })}
            disabled={refreshing}
            className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-brand-700 transition hover:bg-brand-50 disabled:opacity-60"
          >
            <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-3 py-2">
          {(
            [
              { key: "pending", label: "Pending", icon: Clock3 },
              { key: "rejected", label: "Rejected", icon: XCircle },
            ] as const
          ).map(({ key, label, icon: Icon }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition ${
                  active
                    ? "bg-brand-700 text-white shadow-soft"
                    : "text-brand-700 hover:bg-brand-100"
                }`}
              >
                <Icon size={13} />
                {label}
                {key === "pending" && pendingCount !== null && pendingCount > 0 && (
                  <span
                    className={`ml-0.5 inline-flex min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold ${
                      active ? "bg-white/25 text-white" : "bg-rose-100 text-rose-700"
                    }`}
                  >
                    {pendingCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[12.5px] font-medium text-rose-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-64 animate-pulse rounded-2xl border border-slate-200 bg-white shadow-sm"
            />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <MonitorSmartphone className="mx-auto mb-2 h-9 w-9 text-slate-400" />
          <h3 className="text-[13px] font-semibold text-slate-900">
            {tab === "pending"
              ? "No devices awaiting approval"
              : "No rejected devices"}
          </h3>
          <p className="mt-1 text-[12px] text-slate-500">
            {tab === "pending"
              ? "New sign-in requests from your students will appear here."
              : "Devices you reject will be listed here so you can revisit them."}
          </p>
        </div>
      ) : (
        <div className="grid items-start gap-3 lg:grid-cols-2">
          {list.map((device) => (
            <DeviceApprovalCard
              key={device.id}
              device={device}
              onChanged={() => {
                void load(tab, { silent: true });
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DeviceApprovalCard({
  device,
  onChanged,
}: {
  device: ApprovalDevice;
  onChanged: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<null | "approve" | "reject" | "reply">(null);

  const theme =
    device.status === "BLOCKED"
      ? {
          accent: "border-t-rose-400",
          tile: "bg-rose-50 text-rose-600",
          pill: "bg-rose-100 text-rose-700",
          label: "Rejected",
          icon: <XCircle size={11} />,
        }
      : {
          accent: "border-t-amber-400",
          tile: "bg-amber-50 text-amber-600",
          pill: "bg-amber-100 text-amber-700",
          label: "Pending",
          icon: <Clock3 size={11} />,
        };

  const requestedAt =
    device.approvalRequestedByStudentAt ?? device.approvalRequestedAt;

  async function action(
    kind: "approve" | "reject" | "reply"
  ): Promise<void> {
    try {
      setBusy(kind);

      let url: string;
      let payload: Record<string, string> | undefined;

      if (kind === "reply") {
        if (!note.trim()) {
          toast.error("Type a message for the student first.");
          return;
        }
        url = `/api/student/devices/${device.id}/teacher-response`;
        payload = { rejectedReason: note.trim() };
      } else {
        url = `/api/student/devices/${device.id}/${kind}`;
        payload = note.trim() ? { reason: note.trim() } : undefined;
      }

      const res = await fetch(url, {
        method: "PUT",
        headers: payload ? { "Content-Type": "application/json" } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          body?.error?.message ?? body?.message ?? "Something went wrong."
        );
      }

      toast.success(
        kind === "approve"
          ? "Device confirmed."
          : kind === "reject"
            ? "Device rejected."
            : "Reply sent to student."
      );
      setNote("");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const anyBusy = busy !== null;

  return (
    <div
      className={`flex flex-col rounded-2xl border border-slate-200 border-t-2 bg-white shadow-sm ${theme.accent}`}
    >
      {/* Student */}
      <div className="flex items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
            <User size={16} />
          </div>
          <div className="min-w-0">
            <Link
              href={`/dashboard/students/${device.student.id}`}
              className="break-words text-[13px] font-bold leading-tight text-slate-900 hover:text-brand-700 hover:underline"
            >
              {device.student.name}
            </Link>
            <p className="mt-0.5 break-words text-[11px] text-slate-500">
              {device.student.registrationNumber
                ? `${device.student.registrationNumber}`
                : "No reg. number"}
              {device.student.contact ? ` · ${device.student.contact}` : ""}
            </p>
          </div>
        </div>

        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${theme.pill}`}
        >
          {theme.icon}
          {theme.label}
        </span>
      </div>

      {/* Device */}
      <div className="px-4 py-3">
        <div className="flex items-start gap-2.5">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${theme.tile}`}
          >
            <DeviceGlyph device={device} className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0">
            <h3 className="break-words text-[13px] font-semibold leading-tight text-slate-900">
              {device.deviceName ?? device.deviceModel ?? "Unknown device"}
            </h3>
            <p className="mt-0.5 break-words text-[11px] text-slate-500">
              {device.browser ?? "Unknown"}
              {device.browserVersion ? ` ${device.browserVersion}` : ""}
              {" · "}
              {device.os ?? "Unknown OS"}
              {device.osVersion ? ` ${device.osVersion}` : ""}
            </p>
          </div>
        </div>

        <div className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-100">
          <DetailRow icon={<Cpu size={12} />} label="Platform">
            {device.platform ?? "—"}
          </DetailRow>
          <DetailRow icon={<Cpu size={12} />} label="Model">
            {device.deviceModel ?? "—"}
          </DetailRow>
          <DetailRow icon={<Globe size={12} />} label="IP address">
            {device.lastIpAddress ?? "—"}
          </DetailRow>
          <DetailRow icon={<MapPin size={12} />} label="Location">
            {device.city ?? "—"}
            {device.country ? `, ${device.country}` : ""}
          </DetailRow>
          <DetailRow icon={<Clock3 size={12} />} label="Requested">
            {fmt(requestedAt)}
          </DetailRow>
          <DetailRow icon={<LogIn size={12} />} label="First login">
            {fmt(device.firstLoginAt)}
          </DetailRow>
          <DetailRow icon={<Clock3 size={12} />} label="Last login">
            {device.lastLoginAt ? fmt(device.lastLoginAt) : "Never"}
          </DetailRow>
          {device.status === "BLOCKED" && (
            <>
              <DetailRow icon={<XCircle size={12} />} label="Rejected on">
                {fmt(device.rejectedAt)}
              </DetailRow>
              <DetailRow icon={<User size={12} />} label="Rejected by">
                {device.approvedByTeacher?.fullName ?? "—"}
              </DetailRow>
            </>
          )}
        </div>

        {/* Student's message */}
        <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-2">
          <p className="text-[9px] font-semibold uppercase tracking-wide text-blue-700">
            Message from student
          </p>
          <p className="mt-0.5 whitespace-pre-wrap text-[11.5px] leading-4 text-slate-700">
            {device.approvalRequestMessage?.trim() || "No message provided."}
          </p>
        </div>

        {/* Existing teacher reply */}
        {device.rejectedReason?.trim() && (
          <div className="mt-2 rounded-lg border border-emerald-100 bg-emerald-50/70 px-3 py-2">
            <p className="text-[9px] font-semibold uppercase tracking-wide text-emerald-700">
              Your last reply
            </p>
            <p className="mt-0.5 whitespace-pre-wrap text-[11.5px] leading-4 text-slate-700">
              {device.rejectedReason}
            </p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="mt-auto border-t border-slate-100 px-4 py-3">
        <label className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
          Reply / reason for the student (optional)
        </label>
        <textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. I've approved this — you can now sign in on this device."
          className="mt-1 w-full resize-y rounded-lg border border-slate-300 p-2 text-[12px] focus:border-brand-500 focus:outline-none"
        />

        <div className="mt-2 flex flex-wrap gap-2">
          {device.status === "PENDING" && (
            <button
              type="button"
              onClick={() => void action("approve")}
              disabled={anyBusy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
            >
              <CheckCircle2 size={13} />
              {busy === "approve" ? "Confirming..." : "Confirm device"}
            </button>
          )}

          {device.status === "BLOCKED" && (
            <button
              type="button"
              onClick={() => void action("approve")}
              disabled={anyBusy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
            >
              <CheckCircle2 size={13} />
              {busy === "approve" ? "Confirming..." : "Confirm instead"}
            </button>
          )}

          {device.status === "PENDING" && (
            <button
              type="button"
              onClick={() => void action("reject")}
              disabled={anyBusy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-rose-700 disabled:opacity-60"
            >
              <XCircle size={13} />
              {busy === "reject" ? "Rejecting..." : "Reject device"}
            </button>
          )}

          <button
            type="button"
            onClick={() => void action("reply")}
            disabled={anyBusy || !note.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-white px-3 py-1.5 text-[12px] font-semibold text-brand-700 transition hover:bg-brand-50 disabled:opacity-50"
          >
            <MessageSquare size={13} />
            {busy === "reply" ? "Sending..." : "Send reply"}
          </button>
        </div>
      </div>
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
    <div className="flex items-start justify-between gap-3 px-2.5 py-1.5">
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-slate-500">
        <span className="text-slate-400">{icon}</span>
        {label}
      </span>
      <span className="min-w-0 flex-1 break-words text-right text-[11px] font-semibold text-slate-800">
        {children}
      </span>
    </div>
  );
}
