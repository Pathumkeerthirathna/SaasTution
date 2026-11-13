"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";

import {
  CURRENT_PASSWORD_MAX_LENGTH,
  PASSWORD_MESSAGES,
  STUDENT_PASSWORD_MAX_BYTES,
  STUDENT_PASSWORD_MAX_LENGTH,
  STUDENT_PASSWORD_MIN_LENGTH,
  utf8ByteLength,
} from "@/lib/student-password-validation";

/*
 * The shared "Change your password" form (/account/security). Every role sees
 * the confirmation field; students get the full SP-5.6 rules in the browser
 * too (the server enforces them for students only). The page passes the role
 * from the verified session, used only for the back link and the client
 * checks; the server decides everything again.
 */

export type AccountRole = "TEACHER" | "ADMIN" | "STUDENT";

export type PasswordFields = { currentPassword: string; newPassword: string; confirmPassword: string };
export type PasswordFieldName = keyof PasswordFields;
export type PasswordFieldErrors = Partial<Record<PasswordFieldName, string>>;

export const PASSWORD_CHANGE_ENDPOINT = "/api/auth/password/update";

export function passwordBackLink(role: AccountRole): { href: string; label: string } {
  if (role === "STUDENT") return { href: "/student/settings", label: "Back to settings" };
  if (role === "ADMIN") return { href: "/dashboard/admin", label: "Back to dashboard" };
  return { href: "/dashboard", label: "Back to dashboard" };
}

/** Client checks; for students exactly the server's rules (lib/student-password-validation.ts). */
export function checkPasswordChangeForm(values: PasswordFields, role: AccountRole): PasswordFieldErrors {
  const errors: PasswordFieldErrors = {};
  const student = role === "STUDENT";

  if (values.currentPassword.length === 0) errors.currentPassword = PASSWORD_MESSAGES.currentRequired;
  else if (student && values.currentPassword.length > CURRENT_PASSWORD_MAX_LENGTH) errors.currentPassword = PASSWORD_MESSAGES.currentTooLong;

  if (values.newPassword.length === 0) errors.newPassword = PASSWORD_MESSAGES.newRequired;
  else if (values.newPassword.length < STUDENT_PASSWORD_MIN_LENGTH) errors.newPassword = PASSWORD_MESSAGES.tooShort;
  else if (values.newPassword.length > STUDENT_PASSWORD_MAX_LENGTH) errors.newPassword = PASSWORD_MESSAGES.tooLong;
  else if (student && utf8ByteLength(values.newPassword) > STUDENT_PASSWORD_MAX_BYTES) errors.newPassword = PASSWORD_MESSAGES.tooManyBytes;
  else if (student && values.currentPassword.length > 0 && values.newPassword === values.currentPassword) errors.newPassword = PASSWORD_MESSAGES.unchanged;

  if (values.confirmPassword.length === 0) errors.confirmPassword = PASSWORD_MESSAGES.confirmRequired;
  else if (values.confirmPassword !== values.newPassword) errors.confirmPassword = PASSWORD_MESSAGES.mismatch;

  return errors;
}

export type PasswordChangeOutcome =
  | { ok: true; message: string; reauthenticate: boolean }
  | { ok: false; message: string; field: PasswordFieldName | null; signIn: boolean };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const FIELD_NAMES: PasswordFieldName[] = ["currentPassword", "newPassword", "confirmPassword"];

const MESSAGES = {
  sessionExpired: "Your session has expired. Please sign in again.",
  inactive: "Your student account is inactive. Please contact your teacher.",
  crossOrigin: "This request was blocked for security. Reload the page and try again.",
  forbidden: "This account's password can't be changed here.",
  conflict: "Your password could not be changed. Please try again.",
  network: "Unable to update password right now.",
  failed: "Failed to update password.",
  studentSuccess: "Your password was changed. You have been signed out on your other devices.",
  success: "Password updated successfully.",
  reauthenticate: "Your password was changed. Please sign in again.",
} as const;

function minutesFrom(retryAfter: string | null): number | null {
  const seconds = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : null;
}

/** Maps the API answer to what the form shows (fixed text, except the server's field / validation messages). */
export function mapPasswordChangeResponse(status: number, payload: unknown, retryAfter: string | null, role: AccountRole): PasswordChangeOutcome {
  if (status >= 200 && status < 300 && isObject(payload) && payload.success === true) {
    const data = isObject(payload.data) ? payload.data : {};
    if (data.reauthenticate === true) return { ok: true, message: MESSAGES.reauthenticate, reauthenticate: true };
    return { ok: true, message: role === "STUDENT" ? MESSAGES.studentSuccess : MESSAGES.success, reauthenticate: false };
  }

  const error = isObject(payload) && isObject(payload.error) ? payload.error : {};
  const code = typeof error.code === "string" ? error.code : "";
  const serverMessage = typeof error.message === "string" ? error.message : "";
  const details = isObject(error.details) ? error.details : {};
  const field = FIELD_NAMES.find((name) => name === details.field) ?? null;

  if (status === 401) return { ok: false, message: MESSAGES.sessionExpired, field: null, signIn: true };
  if (code === "STUDENT_ACCOUNT_INACTIVE") return { ok: false, message: MESSAGES.inactive, field: null, signIn: false };
  if (code === "CROSS_ORIGIN_REQUEST_REJECTED") return { ok: false, message: MESSAGES.crossOrigin, field: null, signIn: false };
  if (status === 403) return { ok: false, message: MESSAGES.forbidden, field: null, signIn: false };
  if (status === 409) return { ok: false, message: MESSAGES.conflict, field: null, signIn: false };
  if (status === 429) {
    const minutes = minutesFrom(retryAfter);
    const wait = minutes ? `Please wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.` : "Please wait a few minutes and try again.";
    return { ok: false, message: `Too many attempts. ${wait}`, field: null, signIn: false };
  }
  if (code === "INVALID_CURRENT_PASSWORD") return { ok: false, message: "Current password is incorrect.", field: "currentPassword", signIn: false };
  if (status === 400 && code === "VALIDATION_ERROR" && serverMessage) return { ok: false, message: serverMessage, field, signIn: false };
  return { ok: false, message: MESSAGES.failed, field: null, signIn: false };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Sends the three fields; never throws. */
export async function submitPasswordChange(values: PasswordFields, role: AccountRole, fetchImpl: FetchLike = (input, init) => fetch(input, init)): Promise<PasswordChangeOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(PASSWORD_CHANGE_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword, confirmPassword: values.confirmPassword }),
    });
  } catch {
    return { ok: false, message: MESSAGES.network, field: null, signIn: false };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return mapPasswordChangeResponse(response.status, payload, response.headers.get("retry-after"), role);
}

const EMPTY: PasswordFields = { currentPassword: "", newPassword: "", confirmPassword: "" };
const inputClass =
  "w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 aria-[invalid=true]:border-red-400 dark:border-white/20 dark:bg-transparent";

export function PasswordChangeForm({ role }: { role: AccountRole }) {
  const [values, setValues] = useState<PasswordFields>(EMPTY);
  const [errors, setErrors] = useState<PasswordFieldErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [signIn, setSignIn] = useState(false);
  const inFlight = useRef(false);
  const back = passwordBackLink(role);

  const update = (name: PasswordFieldName, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setMessage(null);
    setErrorMessage(null);
    setSignIn(false);

    const found = checkPasswordChangeForm(values, role);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    inFlight.current = true;
    setIsSubmitting(true);
    try {
      const outcome = await submitPasswordChange(values, role);
      if (outcome.ok) {
        setValues(EMPTY);
        setErrors({});
        setMessage(outcome.message);
        setSignIn(outcome.reauthenticate);
        return;
      }
      if (outcome.field) setErrors({ [outcome.field]: outcome.message });
      else setErrorMessage(outcome.message);
      setSignIn(outcome.signIn);
    } finally {
      inFlight.current = false;
      setIsSubmitting(false);
    }
  }

  const field = (name: PasswordFieldName, label: string, autoComplete: string, maxLength: number) => {
    const error = errors[name];
    return (
      <div>
        <label htmlFor={name} className="mb-1 block text-sm font-medium">
          {label}
        </label>
        <input
          id={name}
          name={name}
          type="password"
          required
          autoComplete={autoComplete}
          maxLength={maxLength}
          value={values[name]}
          onChange={(event) => update(name, event.target.value)}
          disabled={isSubmitting}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${name}-error` : undefined}
          className={inputClass}
        />
        {error ? (
          <p id={`${name}-error`} role="alert" className="mt-1 text-sm text-red-700">
            {error}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-8 sm:px-6 lg:px-8">
      <section className="rounded-3xl border border-black/10 bg-card p-6 shadow-sm dark:border-white/10 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Account security</p>
        <h1 className="mt-3 text-2xl font-semibold">Change your password</h1>
        <p className="mt-2 text-sm text-muted">Enter your current password, then set a new one.</p>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
          {field("currentPassword", "Current password", "current-password", role === "STUDENT" ? CURRENT_PASSWORD_MAX_LENGTH : 256)}
          {field("newPassword", "New password", "new-password", STUDENT_PASSWORD_MAX_LENGTH)}
          {field("confirmPassword", "Confirm new password", "new-password", STUDENT_PASSWORD_MAX_LENGTH)}
          <p className="text-xs text-muted">
            {STUDENT_PASSWORD_MIN_LENGTH}–{STUDENT_PASSWORD_MAX_LENGTH} characters.
          </p>

          {errorMessage ? (
            <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {errorMessage}
              {signIn ? (
                <>
                  {" "}
                  <Link href="/login" className="font-semibold underline">
                    Sign in
                  </Link>
                </>
              ) : null}
            </p>
          ) : null}

          {message ? (
            <p role="status" className="rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
              {message}
              {signIn ? (
                <>
                  {" "}
                  <Link href="/login" className="font-semibold underline">
                    Sign in
                  </Link>
                </>
              ) : null}
            </p>
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
          <Link href={back.href} className="font-medium">
            {back.label}
          </Link>
        </div>
      </section>
    </main>
  );
}
