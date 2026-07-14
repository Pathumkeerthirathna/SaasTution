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

        {errorMessage && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 shadow-sm">
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
