"use client";

import { FormEvent, useState } from "react";
import { KeyRound, Lock } from "lucide-react";

import { PASSWORD_MESSAGES, studentNewPasswordSchema } from "@/lib/student-password-validation";

/*
 * First student login (simplified registration): the OPTIONAL "Secure Your
 * Account" step, shown after the registration number and temporary password
 * were accepted. Both answers continue the sign-in through the server, which
 * applies the choice and then runs the unchanged device approval check - no
 * session exists before that. The rules are the shared student password rules
 * (the server enforces the same ones).
 */

export type PasswordSetupSubmit = (choice: { action: "set"; newPassword: string; confirmPassword: string } | { action: "skip" }) => Promise<void>;

/** Client-side check (the server repeats it): null when valid. */
export function validatePasswordSetup(newPassword: string, confirmPassword: string, currentPassword: string): { field: "newPassword" | "confirmPassword"; message: string } | null {
  const parsed = studentNewPasswordSchema.safeParse(newPassword);
  if (!parsed.success) return { field: "newPassword", message: parsed.error.issues[0]?.message ?? PASSWORD_MESSAGES.newRequired };
  if (newPassword === currentPassword) return { field: "newPassword", message: PASSWORD_MESSAGES.unchanged };
  if (!confirmPassword) return { field: "confirmPassword", message: PASSWORD_MESSAGES.confirmRequired };
  if (confirmPassword !== newPassword) return { field: "confirmPassword", message: PASSWORD_MESSAGES.mismatch };
  return null;
}

export function StudentPasswordSetupForm({
  currentPassword,
  isSubmitting,
  serverError,
  onSubmit,
}: {
  currentPassword: string;
  isSubmitting: boolean;
  serverError: string | null;
  onSubmit: PasswordSetupSubmit;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldError, setFieldError] = useState<{ field: "newPassword" | "confirmPassword"; message: string } | null>(null);

  async function handleSet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    const problem = validatePasswordSetup(newPassword, confirmPassword, currentPassword);
    setFieldError(problem);
    if (problem) return;
    await onSubmit({ action: "set", newPassword, confirmPassword });
  }

  const inputClass =
    "w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100";

  return (
    <form className="space-y-3.5" onSubmit={handleSet} noValidate>
      <div>
        <label htmlFor="newPassword" className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          New Password
        </label>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            aria-invalid={fieldError?.field === "newPassword"}
            aria-describedby="password-setup-hint"
            className={inputClass}
            placeholder="At least 8 characters"
          />
        </div>
        <p id="password-setup-hint" className="mt-1 text-[11px] text-slate-500">
          8–64 characters. It must not be your registration number.
        </p>
        {fieldError?.field === "newPassword" ? <p role="alert" className="mt-1 text-[12px] text-red-600">{fieldError.message}</p> : null}
      </div>

      <div>
        <label htmlFor="confirmPassword" className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Confirm Password
        </label>
        <div className="relative">
          <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            aria-invalid={fieldError?.field === "confirmPassword"}
            className={inputClass}
            placeholder="Type the new password again"
          />
        </div>
        {fieldError?.field === "confirmPassword" ? <p role="alert" className="mt-1 text-[12px] text-red-600">{fieldError.message}</p> : null}
      </div>

      {serverError ? (
        <p role="alert" className="whitespace-pre-line rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {serverError}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={isSubmitting}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 focus:ring-2 focus:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting ? "Please wait..." : "Set New Password"}
      </button>

      <button
        type="button"
        disabled={isSubmitting}
        onClick={() => void onSubmit({ action: "skip" })}
        className="flex w-full items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        Skip for Now
      </button>

      <p className="text-center text-[11px] text-slate-500">
        You can change your password later in your account settings or with &quot;Forgot password&quot;.
      </p>
    </form>
  );
}
