"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, LogIn, Mail, ShieldCheck } from "lucide-react";

type ApiError = {
  message?: string;
};

export function GuardianLoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/guardian-auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: ApiError;
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to sign in.");
        return;
      }

      router.push("/guardian/dashboard");
      router.refresh();
    } catch {
      setErrorMessage("Unable to sign in right now. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="space-y-3.5" onSubmit={handleSubmit}>
      {/* Email */}
      <div>
        <label
          htmlFor="guardianLoginEmail"
          className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500"
        >
          Email address
        </label>

        <div className="relative">
          <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            id="guardianLoginEmail"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            placeholder="guardian@example.com"
          />
        </div>
      </div>

      {/* Password */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <label
            htmlFor="guardianLoginPassword"
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
            id="guardianLoginPassword"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            placeholder="Enter your password"
          />
        </div>
      </div>

      {errorMessage ? (
        <p className="whitespace-pre-line rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {errorMessage}
        </p>
      ) : null}

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

      <p className="rounded-lg bg-slate-50 px-3 py-2 text-center text-[11.5px] leading-4 text-slate-500">
        Your teacher creates your guardian account and emails your sign-in
        details.
      </p>
    </form>
  );
}
