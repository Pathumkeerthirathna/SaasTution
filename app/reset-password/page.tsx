"use client";

import { FormEvent, useState } from "react";
import { CheckCircle2, IdCard, KeyRound, Send } from "lucide-react";

import { AuthShell } from "@/components/auth-shell";
import { AuthIllustration } from "@/components/auth-illustration";

export default function ResetPasswordRequestPage() {
  const [loginId, setLoginId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);
    setMessage(null);

    try {
      const response = await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ loginId }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        meta?: { message?: string };
        error?: { message?: string };
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to request password reset.");
        return;
      }

      setMessage(
        payload.meta?.message ??
          "If an account exists, a reset link has been sent to the registered email address."
      );
      setLoginId("");
    } catch {
      setErrorMessage("Unable to request password reset right now.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter your email or registration number and we'll send a reset link to the registered email address."
      footerText="Remembered it?"
      footerLinkHref="/login"
      footerLinkLabel="Sign in"
      icon={<KeyRound className="h-5 w-5" />}
      illustration={<AuthIllustration />}
      showBackToHome
    >
      <form className="space-y-3.5" onSubmit={handleSubmit}>
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
              value={loginId}
              onChange={(event) => setLoginId(event.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              placeholder="teacher@school.com or ABC-2026-001"
            />
          </div>
        </div>

        {errorMessage ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
            {errorMessage}
          </p>
        ) : null}

        {message ? (
          <p className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
            {message}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 focus:ring-2 focus:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Send className="h-4 w-4" />
          {isSubmitting ? "Sending link..." : "Send reset link"}
        </button>
      </form>
    </AuthShell>
  );
}
