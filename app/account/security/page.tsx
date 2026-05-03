"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

export default function AccountSecurityPage() {
  const [currentPassword, setCurrentPassword] = useState("");
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
      const response = await fetch("/api/auth/password/update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        meta?: { message?: string };
        error?: { message?: string };
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to update password.");
        return;
      }

      setCurrentPassword("");
      setNewPassword("");
      setMessage(payload.meta?.message ?? "Password updated successfully.");
    } catch {
      setErrorMessage("Unable to update password right now.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-8 sm:px-6 lg:px-8">
      <section className="rounded-3xl border border-black/10 bg-card p-6 shadow-sm dark:border-white/10 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Account security</p>
        <h1 className="mt-3 text-2xl font-semibold">Change your password</h1>
        <p className="mt-2 text-sm text-muted">Enter your current password, then set a new one.</p>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="currentPassword" className="mb-1 block text-sm font-medium">
              Current password
            </label>
            <input
              id="currentPassword"
              type="password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
            />
          </div>

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
            className="rounded-xl bg-foreground px-4 py-2.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? "Saving..." : "Update password"}
          </button>
        </form>

        <div className="mt-6 text-sm">
          <Link href="/dashboard" className="font-medium">
            Back to dashboard
          </Link>
        </div>
      </section>
    </main>
  );
}
