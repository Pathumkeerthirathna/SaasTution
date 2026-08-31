"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { Lock, Mail, UserPlus, UserRound } from "lucide-react";

import { AuthShell } from "@/components/auth-shell";
import { AuthIllustration } from "@/components/auth-illustration";

type RegisterFormState = {
  name: string;
  email: string;
  password: string;
};

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100";

const LABEL_CLASS =
  "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500";

const ICON_CLASS =
  "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400";

export default function RegisterPage() {
  const router = useRouter();
  const [formState, setFormState] = useState<RegisterFormState>({
    name: "",
    email: "",
    password: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(formState),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: { message?: string };
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Unable to register. Please try again.");
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch {
      setErrorMessage("Unable to register right now. Please try again in a moment.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Create teacher account"
      subtitle="Register securely to manage classes, lectures and student updates."
      footerText="Already have an account?"
      footerLinkHref="/login"
      footerLinkLabel="Sign in"
      icon={<UserPlus className="h-5 w-5" />}
      illustration={<AuthIllustration />}
      showBackToHome
    >
      <form className="space-y-3.5" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="name" className={LABEL_CLASS}>
            Full name
          </label>
          <div className="relative">
            <UserRound className={ICON_CLASS} />
            <input
              id="name"
              type="text"
              required
              autoComplete="name"
              value={formState.name}
              onChange={(event) => setFormState((prev) => ({ ...prev, name: event.target.value }))}
              className={INPUT_CLASS}
              placeholder="Enter your full name"
            />
          </div>
        </div>

        <div>
          <label htmlFor="email" className={LABEL_CLASS}>
            Email address
          </label>
          <div className="relative">
            <Mail className={ICON_CLASS} />
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={formState.email}
              onChange={(event) => setFormState((prev) => ({ ...prev, email: event.target.value }))}
              className={INPUT_CLASS}
              placeholder="teacher@school.com"
            />
          </div>
        </div>

        <div>
          <label htmlFor="password" className={LABEL_CLASS}>
            Password
          </label>
          <div className="relative">
            <Lock className={ICON_CLASS} />
            <input
              id="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={formState.password}
              onChange={(event) =>
                setFormState((prev) => ({ ...prev, password: event.target.value }))
              }
              className={INPUT_CLASS}
              placeholder="At least 8 characters"
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
          <UserPlus className="h-4 w-4" />
          {isSubmitting ? "Creating account..." : "Create account"}
        </button>

        <p className="text-center text-[11px] leading-4 text-slate-400">
          By registering, you agree to the platform security policy and safe data
          handling rules.
        </p>
      </form>
    </AuthShell>
  );
}
