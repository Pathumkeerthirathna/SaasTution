"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";
import { IdCard, Lock, LogIn, ShieldCheck } from "lucide-react";

import { AuthShell } from "@/components/auth-shell";
import { AuthIllustration } from "@/components/auth-illustration";
import { getCurrentDevice } from "@/lib/current-device";
import { RejectedDeviceCard } from "./RejectedDeviceCard";
import toast from "react-hot-toast";

type LoginFormState = {
  loginId: string;
  password: string;
};

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = useMemo(() => searchParams.get("next") || "/dashboard", [searchParams]);
  const inviteToken = useMemo(() => searchParams.get("invite") || "", [searchParams]);

  const [formState, setFormState] = useState<LoginFormState>({
    loginId: "",
    password: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  type DeviceApprovalData = {
    currentDevice?: {
      id: string;
      deviceName?: string;
      browser?: string;
      os?: string;
      rejectedReason?: string;
      approvalRequestMessage?: string;
      status:string
    };
    approvedDevices?: {
      id: string;
      deviceName?: string;
      browser?: string;
      os?: string;
      lastLoginAt?: string;
    }[];
    allowRequestAgain?: boolean;
  };

  const [deviceApproval, setDeviceApproval] =
    useState<DeviceApprovalData | null>(null);

  const [requestMessage, setRequestMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

    const device = await getCurrentDevice();

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          loginId: formState.loginId,
          password: formState.password,
          inviteToken,
          device
        }),
      });

      // const payload = (await response.json()) as {
      //   success: boolean;
      //   data?: {
      //     redirectTo?: string;
      //   };
      //   error?: { message?: string };
      // };

      if (response.status >= 500) {
        setErrorMessage(
          "Something went wrong on our end. Please contact your administrator."
        );
        return;
      }

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const err = payload.error ?? {};
        let message = err.message ?? "Unable to sign in.";

        if (
          err.code === "STUDENT_PENDING_APPROVAL" ||
          err.code === "STUDENT_DEACTIVATED"
        ) {
          const d = err.details ?? {};
          const contacts = [d.phone, d.whatsapp].filter(Boolean).join(" / ");
          const who = d.teacherName ?? "your teacher";
          message += contacts
            ? `\n\nContact your teacher: ${who} — ${contacts}`
            : `\n\nPlease contact your teacher (${who}).`;
        }

        setErrorMessage(message);

        if (
          err.code === "DEVICE_REJECTED" ||
          err.code === "DEVICE_PENDING"
        ) {
          setDeviceApproval(err.details);
        }

        return;
      }

      if (!payload.success) {
        setErrorMessage(payload.error?.message ?? "Unable to sign in. Please try again.");
        return;
      }

      const redirectTo = payload.data?.redirectTo ?? nextPath;
      router.push(redirectTo);
      router.refresh();
    } catch {
      setErrorMessage("Unable to sign in right now. Please try again in a moment.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const handleRequestAgain = async () => {
    if (!deviceApproval?.currentDevice?.id) return false;

    try {
      const response = await fetch(
        `/api/student/devices/${deviceApproval.currentDevice.id}/request-again`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: requestMessage,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok) {

        toast.error(result.message);
        return false;
      }

      toast.success("Your request has been sent to your teacher.");

      setRequestMessage(requestMessage);

        return true;

      // setDeviceApproval({
      //   ...deviceApproval,
      //   currentDevice: {
      //     ...deviceApproval.currentDevice,
      //     status: "PENDING",
      //   },
      // });

    } catch {
      toast.error("Unable to send request.");
        return false;
    }
  };

  const status = deviceApproval?.currentDevice?.status;

  const deviceAside =
    status === "PENDING" ? (
      <div className="overflow-hidden rounded-xl border border-amber-200 bg-white shadow-sm">
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-amber-200 bg-amber-50 p-3.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-base">
            ⏳
          </div>
          <div>
            <h2 className="text-[13px] font-bold text-slate-900">
              New device pending approval
            </h2>
            <p className="mt-0.5 text-[11px] leading-4 text-slate-600">
              Your request has been sent to your teacher. Until it&apos;s approved,
              keep using one of your approved devices below.
            </p>
          </div>
        </div>

        <div className="space-y-3.5 p-3.5">
          {/* Current Device */}
          <div>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Current device
            </h3>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Device</p>
                <p className="mt-0.5 font-medium text-slate-800">{deviceApproval?.currentDevice?.deviceName}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Browser</p>
                <p className="mt-0.5 font-medium text-slate-800">{deviceApproval?.currentDevice?.browser}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Operating system</p>
                <p className="mt-0.5 font-medium text-slate-800">{deviceApproval?.currentDevice?.os}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Status</p>
                <span className="mt-0.5 inline-flex rounded-full bg-yellow-100 px-2 py-0.5 text-[10px] font-semibold text-yellow-700">
                  Pending approval
                </span>
              </div>
            </div>
          </div>

          {/* Approved Devices */}
          {deviceApproval?.approvedDevices?.length ? (
            <div>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Approved devices
              </h3>
              <div className="space-y-2">
                {deviceApproval.approvedDevices.map((device) => (
                  <div
                    key={device.id}
                    className="rounded-lg border border-emerald-200 bg-emerald-50 p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-slate-900">{device.deviceName}</p>
                        <p className="mt-0.5 text-[11px] text-slate-600">
                          {device.browser} • {device.os}
                        </p>
                        {device.lastLoginAt && (
                          <p className="mt-0.5 text-[10px] text-slate-500">
                            Last login: {new Date(device.lastLoginAt).toLocaleString()}
                          </p>
                        )}
                      </div>
                      <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">
                        Approved
                      </span>
                    </div>
                    <p className="mt-2 rounded-md border border-green-100 bg-white p-2 text-[11px] leading-4 text-slate-700">
                      You can keep using this device while your teacher reviews the new one.
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] leading-4 text-slate-700">
              This is your first device request. Your teacher must approve it before you can sign in.
            </p>
          )}

          {/* Information */}
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
            <h4 className="text-[11px] font-semibold text-slate-900">What happens next?</h4>
            <ul className="mt-1.5 space-y-1 text-[11px] leading-4 text-slate-600">
              <li>• Your teacher has received your request.</li>
              <li>• They will review this device.</li>
              <li>• You can use this device once approved.</li>
              {deviceApproval?.approvedDevices?.length ? (
                <li>• Until then, sign in from an approved device above.</li>
              ) : (
                <li>• Please wait for your teacher to approve your first device.</li>
              )}
            </ul>
          </div>
        </div>
      </div>
    ) : status === "BLOCKED" && deviceApproval ? (
      <RejectedDeviceCard
        deviceApproval={deviceApproval}
        requestMessage={requestMessage}
        setRequestMessage={setRequestMessage}
        onRequestAgain={handleRequestAgain}
        setDeviceApproval={setDeviceApproval}
      />
    ) : undefined;

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to manage classes, students, attendance and payments."
      footerText="Need a teacher account?"
      footerLinkHref="/register"
      footerLinkLabel="Register"
      icon={<ShieldCheck className="h-5 w-5" />}
      illustration={<AuthIllustration />}
      aside={deviceAside}
      showBackToHome
    >
      <form className="space-y-3.5" onSubmit={handleSubmit}>
        {/* Login */}
        <div>
          <label
            htmlFor="loginId"
            className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500"
          >
            Email or Registration Number
          </label>

          <div className="relative">
            <IdCard className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              id="loginId"
              type="text"
              required
              autoComplete="username"
              value={formState.loginId}
              onChange={(event) =>
                setFormState((prev) => ({
                  ...prev,
                  loginId: event.target.value,
                }))
              }
              className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              placeholder="teacher@mail.com or ST20260001"
            />
          </div>
        </div>

        {/* Password */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label
              htmlFor="password"
              className="text-[11px] font-semibold uppercase tracking-wide text-slate-500"
            >
              Password
            </label>

            <Link
              href="/reset-password"
              className="text-[11px] font-semibold text-emerald-700 transition hover:text-emerald-800"
            >
              Forgot password?
            </Link>
          </div>

          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={formState.password}
              onChange={(event) =>
                setFormState((prev) => ({
                  ...prev,
                  password: event.target.value,
                }))
              }
              className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              placeholder="Enter your password"
            />
          </div>
        </div>

        {/* Error */}
        {errorMessage && !deviceApproval && (
          <p className="whitespace-pre-line rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
            {errorMessage}
          </p>
        )}

        {/* Button */}
        <button
          type="submit"
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 focus:ring-2 focus:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <LogIn className="h-4 w-4" />
          {isSubmitting ? "Signing in..." : "Sign In"}
        </button>

        <p className="flex items-center justify-center gap-1.5 text-[11px] font-medium text-slate-400">
          <ShieldCheck className="h-3 w-3 text-emerald-500" />
          Secure, encrypted sign-in
        </p>
      </form>
    </AuthShell>
  );
}
