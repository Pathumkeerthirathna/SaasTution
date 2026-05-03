"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";

import { AuthShell } from "@/components/auth-shell";

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

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
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          redirectTo?: string;
        };
        error?: { message?: string };
      };

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

  return (
    <AuthShell
      title="Teacher, Admin, and Student sign in"
      subtitle="Teachers and admins can use email, while students can use registration number."
      footerText="Need a teacher account?"
      footerLinkHref="/register"
      footerLinkLabel="Register"
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="loginId" className="mb-1 block text-sm font-medium">
            Email or registration number
          </label>
          <input
            id="loginId"
            type="text"
            required
            autoComplete="username"
            value={formState.loginId}
            onChange={(event) => setFormState((prev) => ({ ...prev, loginId: event.target.value }))}
            className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none ring-0 transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
            placeholder="teacher@school.com or ABC-2026-001"
          />
        </div>

        <div>
          <label htmlFor="password" className="mb-1 block text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={formState.password}
            onChange={(event) => setFormState((prev) => ({ ...prev, password: event.target.value }))}
            className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none ring-0 transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
            placeholder="Enter your password"
          />
        </div>

        {errorMessage ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-xl bg-foreground px-4 py-2.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? "Signing in..." : "Sign in"}
        </button>

        <div className="text-center text-sm">
          <Link href="/reset-password" className="font-medium text-brand-700 hover:underline">
            Forgot password?
          </Link>
        </div>
      </form>

      <div className="mt-6 text-center text-sm">
        <Link href="/" className="font-medium">
          Back to home
        </Link>
      </div>
    </AuthShell>
  );
}
