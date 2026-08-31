"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FormEvent, useMemo, useState } from "react";
import { CheckCircle2, KeyRound, Lock } from "lucide-react";

import { AuthShell } from "@/components/auth-shell";
import { AuthIllustration } from "@/components/auth-illustration";

function passwordProblem(value: string): string | null {
  if (value.length < 8) return "Use at least 8 characters.";
  if (!/[a-z]/.test(value)) return "Include a lowercase letter.";
  if (!/[A-Z]/.test(value)) return "Include an uppercase letter.";
  if (!/[0-9]/.test(value)) return "Include a number.";
  return null;
}

function ResetPasswordConfirmContent() {
  const searchParams = useSearchParams();
  const token = useMemo(() => searchParams.get("token") ?? "", [searchParams]);

  const [newPassword, setNewPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const problem = passwordProblem(newPassword);
    if (problem) {
      setErrorMessage(problem);
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setMessage(null);

    try {
      const response = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token,
          newPassword,
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: { message?: string };
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to reset password.");
        return;
      }

      setMessage("Password reset successfully. You can now sign in with the new password.");
      setNewPassword("");
    } catch {
      setErrorMessage("Unable to reset password right now.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!token) {
    return (
      <AuthShell
        title="Reset link is missing"
        subtitle="Use the link from your email, or request a new reset link."
        footerText="Need a new link?"
        footerLinkHref="/reset-password"
        footerLinkLabel="Request one"
        icon={<KeyRound className="h-5 w-5" />}
        illustration={<AuthIllustration />}
        showBackToHome
      >
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          The reset link is invalid or has expired. Request a fresh one and try again.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Set a new password"
      subtitle="Choose a strong password for your account."
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
            htmlFor="newPassword"
            className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500"
          >
            New password
          </label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              id="newPassword"
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              placeholder="At least 8 characters"
            />
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            At least 8 characters, with one uppercase letter, one lowercase letter
            and a number.
          </p>
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
          <KeyRound className="h-4 w-4" />
          {isSubmitting ? "Saving..." : "Reset password"}
        </button>
      </form>
    </AuthShell>
  );
}

export default function ResetPasswordConfirmPage() {
  return (
    <Suspense fallback={<main className="p-6 text-sm text-muted">Loading reset link...</main>}>
      <ResetPasswordConfirmContent />
    </Suspense>
  );
}
