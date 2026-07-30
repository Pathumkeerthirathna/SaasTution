"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";

import { AuthShell } from "@/components/auth-shell";
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

    console.log(device);


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

      

      console.log(device);

      // const payload = (await response.json()) as {
      //   success: boolean;
      //   data?: {
      //     redirectTo?: string;
      //   };
      //   error?: { message?: string };
      // };

      const payload = await response.json();

      console.log(payload);

      if (!response.ok) {
        setErrorMessage(payload.error?.message ?? "Unable to sign in.");

        if (
          payload.error?.code === "DEVICE_REJECTED" ||
          payload.error?.code === "DEVICE_PENDING"
        ) {
          setDeviceApproval(payload.error.details);
        }

        return;
      }

      if (!response.ok || !payload.success) {
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

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to manage classes, students, attendance and payments."
      footerText="Need a teacher account?"
      footerLinkHref="/register"
      footerLinkLabel="Register"
    >
      <form
        className="space-y-5 max-w-xl" 
        onSubmit={handleSubmit}
      >
        {/* Login */}

         <div>
    <label
      htmlFor="loginId"
      className="mb-2 block text-sm font-semibold text-slate-700"
    >
      Email or Registration Number
    </label>

    <div className="relative">

      <svg
        className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M16 12H8m8-4H8m8 8H8"
        />
      </svg>

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
        className="
          w-full
          rounded-2xl
          border
          border-slate-200
          bg-slate-50
          py-3.5
          pl-12
          pr-4
          text-sm
          transition-all
          outline-none
          placeholder:text-slate-400
          focus:border-emerald-500
          focus:bg-white
          focus:ring-4
          focus:ring-emerald-100
        "
        placeholder="teacher@mail.com or ST20260001"
      />
    </div>
        </div>

        {/* Password */}

        <div>

          <div className="mb-2 flex items-center justify-between">

            <label
              htmlFor="password"
              className="text-sm font-semibold text-slate-700"
            >
              Password
            </label>

            <Link
              href="/reset-password"
              className="text-xs font-semibold text-orange-600 transition hover:text-orange-700"
            >
              Forgot Password?
            </Link>

          </div>

          <div className="relative">

            <svg
              className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6-6V9a6 6 0 1112 0v2"
              />
              <rect
                x="4"
                y="11"
                width="16"
                height="10"
                rx="2"
              />
            </svg>

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
              className="
                w-full
                rounded-2xl
                border
                border-slate-200
                bg-slate-50
                py-3.5
                pl-12
                pr-4
                text-sm
                transition-all
                outline-none
                placeholder:text-slate-400
                focus:border-emerald-500
                focus:bg-white
                focus:ring-4
                focus:ring-emerald-100
              "
              placeholder="Enter your password"
            />

          </div>

        </div>

        {/* Error */}

       {deviceApproval?.currentDevice?.status === "PENDING" && (
          <div className="mt-6 overflow-hidden rounded-3xl border border-amber-200 bg-white shadow-lg">

            {/* Header */}
            <div className="border-b border-amber-200 bg-gradient-to-r from-amber-50 to-yellow-50 p-6">

              <div className="flex items-center gap-4">

                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-100">
                  <span className="text-3xl">⏳</span>
                </div>

                <div>

                  <h2 className="text-xl font-bold text-slate-900">
                    New Device Pending Approval
                  </h2>

                  <p className="mt-1 text-sm text-slate-600">
                    Your request has been sent to your teacher.
                    Until this device is approved you can continue using one of your
                    approved devices below.
                  </p>

                </div>

              </div>

            </div>

            <div className="space-y-6 p-6">

              {/* Current Device */}

              <div>

                <div className="mb-3 flex items-center gap-2">

                  <span className="text-xl">📱</span>

                  <h3 className="font-semibold">
                    Current Device
                  </h3>

                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">

                  <div className="grid grid-cols-2 gap-4">

                    <div>

                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Device
                      </p>

                      <p className="mt-1 font-medium">
                        {deviceApproval.currentDevice?.deviceName}
                      </p>

                    </div>

                    <div>

                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Browser
                      </p>

                      <p className="mt-1 font-medium">
                        {deviceApproval.currentDevice?.browser}
                      </p>

                    </div>

                    <div>

                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Operating System
                      </p>

                      <p className="mt-1 font-medium">
                        {deviceApproval.currentDevice?.os}
                      </p>

                    </div>

                    <div>

                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Status
                      </p>

                      <span className="mt-1 inline-flex rounded-full bg-yellow-100 px-3 py-1 text-xs font-semibold text-yellow-700">
                        Pending Approval
                      </span>

                    </div>

                  </div>

                </div>

              </div>

              {/* Approved Devices */}

              {deviceApproval.approvedDevices?.length ? (

                <div>

                  <div className="mb-3 flex items-center gap-2">

                    <span className="text-xl">💻</span>

                    <h3 className="font-semibold">
                      Approved Devices
                    </h3>

                  </div>

                  <div className="space-y-4">

                    {deviceApproval.approvedDevices.map((device) => (

                      <div
                        key={device.id}
                        className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5"
                      >

                        <div className="flex items-start justify-between">

                          <div>

                            <h4 className="font-semibold text-slate-900">
                              {device.deviceName}
                            </h4>

                            <p className="mt-1 text-sm text-slate-600">
                              {device.browser} • {device.os}
                            </p>

                            {device.lastLoginAt && (
                              <p className="mt-2 text-xs text-slate-500">
                                Last login:
                                {" "}
                                {new Date(device.lastLoginAt).toLocaleString()}
                              </p>
                            )}

                          </div>

                          <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700">
                            Approved
                          </span>

                        </div>

                        <div className="mt-4 rounded-xl border border-green-100 bg-white p-4">

                          <p className="text-sm text-slate-700">

                            ✅ <strong>You can continue using this approved device</strong>
                            {" "}
                            while your teacher reviews your new device request.

                          </p>

                        </div>

                      </div>

                    ))}

                  </div>

                </div>

              ) : (

                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">

                  <p className="text-sm text-slate-700">
                    This is your first device request.
                    Your teacher must approve it before you can sign in.
                  </p>

                </div>

              )}

              {/* Information */}

              <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5">

                <h4 className="font-semibold text-slate-900">
                  ℹ What happens next?
                </h4>

                <ul className="mt-3 space-y-2 text-sm text-slate-600">

                  <li>• Your teacher has received your request.</li>

                  <li>• They will review this device.</li>

                  <li>• You will be able to use this device after approval.</li>

                  {deviceApproval.approvedDevices?.length ? (
                    <li>
                      • Until then, sign in using one of your approved devices shown above.
                    </li>
                  ) : (
                    <li>
                      • Please wait for your teacher to approve your first device.
                    </li>
                  )}

                </ul>

              </div>

            </div>

          </div>
        )}


        {deviceApproval?.currentDevice?.status === "BLOCKED" && (
          <RejectedDeviceCard
            deviceApproval={deviceApproval}
            requestMessage={requestMessage}
            setRequestMessage={setRequestMessage}
            onRequestAgain={handleRequestAgain}
            setDeviceApproval={setDeviceApproval}
          />
        )}


        {/* Button */}

        <button
          type="submit"
          disabled={isSubmitting}
          className="
            w-full
            rounded-2xl
            bg-gradient-to-r
            from-emerald-600
            via-emerald-600
            to-orange-500
            px-5
            py-3.5
            text-base
            font-semibold
            text-white
            shadow-lg
            transition-all
            duration-300
            hover:-translate-y-0.5
            hover:shadow-2xl
            disabled:cursor-not-allowed
            disabled:opacity-60
          "
        >
          {isSubmitting
            ? "Signing in..."
            : "Sign In"}
        </button>

        {/* Divider */}

        <div className="relative py-2">

          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-slate-200" />
          </div>

          <div className="relative flex justify-center">
            <span className="rounded-full bg-white px-4 text-[11px] font-semibold uppercase tracking-[0.25em] text-slate-400">
              Secure Login
            </span>
          </div>

        </div>

        {/* Info */}

       

      </form>

      <div className="mt-8 border-t border-slate-200 pt-6 text-center">

        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 transition hover:text-emerald-600"
        >
          ← Back to Home
        </Link>

      </div>
    </AuthShell>
  );
}
