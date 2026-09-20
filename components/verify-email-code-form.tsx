"use client";

import { FormEvent, useEffect, useState } from "react";
import { KeyRound, MailCheck } from "lucide-react";

type VerifyEmailCodeFormProps = {
  loginId: string;
  email: string;
  /** Called after the code has been accepted by the server. */
  onVerified: () => void | Promise<void>;
  /** Optional: lets the user go back to the previous step. */
  onCancel?: () => void;
};

const RESEND_COOLDOWN_SECONDS = 60;

export function VerifyEmailCodeForm({
  loginId,
  email,
  onVerified,
  onCancel,
}: VerifyEmailCodeFormProps) {
  const [code, setCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setInfoMessage(null);

    if (!/^[0-9]{6}$/.test(code.trim())) {
      setErrorMessage("Enter the 6-digit code sent to your email.");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId, code: code.trim() }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Unable to verify this code.");
        return;
      }

      await onVerified();
    } catch {
      setErrorMessage("Unable to verify right now. Please try again in a moment.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResend() {
    setErrorMessage(null);
    setInfoMessage(null);

    try {
      const response = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Unable to resend the code.");
        return;
      }

      setInfoMessage("A new code has been sent to your email.");
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch {
      setErrorMessage("Unable to resend the code right now.");
    }
  }

  return (
    <form className="space-y-3.5" onSubmit={handleSubmit} noValidate>
      <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5">
        <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        <p className="text-[12px] leading-5 text-emerald-800">
          We sent a 6-digit confirmation code to <span className="font-semibold">{email}</span>.
          Enter it below to continue.
        </p>
      </div>

      <div>
        <label
          htmlFor="verification-code"
          className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500"
        >
          Confirmation code
        </label>
        <div className="relative">
          <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            id="verification-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ""))}
            className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-center text-lg font-semibold tracking-[0.5em] text-slate-900 outline-none transition placeholder:tracking-normal placeholder:text-sm placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            placeholder="123456"
          />
        </div>
      </div>

      {errorMessage ? (
        <p className="whitespace-pre-line rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {errorMessage}
        </p>
      ) : null}

      {infoMessage ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-700">
          {infoMessage}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={isSubmitting}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 focus:ring-2 focus:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <KeyRound className="h-4 w-4" />
        {isSubmitting ? "Verifying..." : "Confirm email"}
      </button>

      <div className="flex items-center justify-between text-[12px]">
        <button
          type="button"
          onClick={handleResend}
          disabled={cooldown > 0}
          className="font-semibold text-emerald-700 transition hover:text-emerald-800 disabled:cursor-not-allowed disabled:text-slate-400"
        >
          {cooldown > 0 ? `Resend code (${cooldown}s)` : "Resend code"}
        </button>

        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="font-medium text-slate-400 transition hover:text-slate-600"
          >
            Back
          </button>
        ) : null}
      </div>
    </form>
  );
}
