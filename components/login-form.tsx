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
      title="Welcome back"
      subtitle="Sign in to manage classes, students, attendance and payments."
      footerText="Need a teacher account?"
      footerLinkHref="/register"
      footerLinkLabel="Register"
    >
      <form
        className="space-y-5"
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
                px-4
                py-3
                text-sm
                outline-none
                transition-all
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
              className="text-xs font-semibold text-orange-600 hover:text-orange-700"
            >
              Forgot Password?
            </Link>
          </div>

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
              px-4
              py-3
              text-sm
              outline-none
              transition-all
              placeholder:text-slate-400
              focus:border-emerald-500
              focus:bg-white
              focus:ring-4
              focus:ring-emerald-100
            "
            placeholder="Enter your password"
          />
        </div>

        {/* Error */}

        {errorMessage && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {errorMessage}
          </div>
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
            to-orange-500
            px-4
            py-3
            text-sm
            font-semibold
            text-white
            shadow-lg
            shadow-emerald-200
            transition-all
            duration-300
            hover:-translate-y-0.5
            hover:shadow-xl
            hover:shadow-orange-200
            disabled:cursor-not-allowed
            disabled:opacity-60
          "
        >
          {isSubmitting
            ? "Signing in..."
            : "Sign In"}
        </button>

        {/* Divider */}

        <div className="relative py-1">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-slate-200" />
          </div>

          <div className="relative flex justify-center">
            <span className="bg-white px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
              Secure Login
            </span>
          </div>
        </div>

        {/* Info */}

        <div className="rounded-2xl border border-emerald-100 bg-gradient-to-r from-emerald-50 to-orange-50 p-4">
          <p className="text-sm font-semibold text-slate-800">
            SaasTution Management System
          </p>

          <p className="mt-1 text-xs leading-5 text-slate-600">
            Teachers and administrators can sign in using
            their email address. Students can use their
            registration number and password.
          </p>
        </div>
      </form>

      <div className="mt-6 border-t border-slate-200 pt-5 text-center">
        <Link
          href="/"
          className="text-sm font-semibold text-slate-600 transition hover:text-emerald-600"
        >
          ← Back to Home
        </Link>
      </div>
    </AuthShell>
  );
}
