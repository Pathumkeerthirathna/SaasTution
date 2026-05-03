"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FormEvent, useMemo, useState } from "react";

function ResetPasswordConfirmContent() {
  const searchParams = useSearchParams();
  const token = useMemo(() => searchParams.get("token") ?? "", [searchParams]);

  const [newPassword, setNewPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-10 sm:px-6">
        <section className="w-full rounded-3xl border border-black/10 bg-card p-6 shadow-sm dark:border-white/10 sm:p-8">
          <h1 className="text-2xl font-semibold">Reset link is missing</h1>
          <p className="mt-2 text-sm text-muted">Use the link from your email, or request a new reset link.</p>
          <div className="mt-6 text-sm">
            <Link href="/reset-password" className="font-medium text-brand-700 hover:underline">
              Request a new reset link
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-10 sm:px-6">
      <section className="w-full rounded-3xl border border-black/10 bg-card p-6 shadow-sm dark:border-white/10 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Password reset</p>
        <h1 className="mt-3 text-2xl font-semibold">Set your new password</h1>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="newPassword" className="mb-1 block text-sm font-medium">
              New password
            </label>
            <input
              id="newPassword"
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
              placeholder="At least 8 characters"
            />
          </div>

          {errorMessage ? (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>
          ) : null}

          {message ? (
            <p className="rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>
          ) : null}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-xl bg-foreground px-4 py-2.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? "Saving..." : "Reset password"}
          </button>
        </form>

        <div className="mt-6 text-center text-sm">
          <Link href="/login" className="font-medium">
            Back to login
          </Link>
        </div>
      </section>
    </main>
  );
}

export default function ResetPasswordConfirmPage() {
  return (
    <Suspense fallback={<main className="p-6 text-sm text-muted">Loading reset link...</main>}>
      <ResetPasswordConfirmContent />
    </Suspense>
  );
}
