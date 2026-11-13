"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, KeyRound, Lock } from "lucide-react";

import {
  PASSWORD_MESSAGES,
  STUDENT_PASSWORD_MAX_BYTES,
  STUDENT_PASSWORD_MAX_LENGTH,
  STUDENT_PASSWORD_MIN_LENGTH,
  utf8ByteLength,
} from "@/lib/student-password-validation";

/*
 * "Set a new password" (Student Profile SP-7E), shared by every role on
 * /reset-password/confirm?token=… — the link format of every reset email.
 *
 * The token:
 *  - is read ONCE, from the address the page was opened with, and the
 *    address is immediately replaced (history.replaceState) by the same page
 *    without it, so neither the address bar nor the history entry (back /
 *    forward) holds it afterwards;
 *  - lives only in component memory, is sent only to the confirmation API
 *    (same origin, relative URL: HTTPS in production) and is dropped once
 *    the link is used or refused; it is never stored, logged or put in a URL.
 *
 * The page cannot know whose link it is (the token is opaque), so the
 * browser checks only rules that hold for EVERY role: required, 8–64
 * characters, at most 72 UTF-8 bytes (bcrypt ignores the rest), and the
 * confirmation must match. Role-specific rules (a student's registration
 * number) are the server's; its validation message is shown as is.
 */

export const PASSWORD_RESET_CONFIRM_ENDPOINT = "/api/auth/password-reset/confirm";
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

type LocationLike = { href: string };
type HistoryLike = { replaceState(data: unknown, unused: string, url?: string | null): void };

/**
 * Takes the reset token out of the current address: returns it (or null when
 * absent / malformed) and, whenever a `token` parameter was present, replaces
 * the current history entry with the same address without it.
 */
export function takeResetTokenFromLocation(location: LocationLike, history: HistoryLike): string | null {
  let url: URL;
  try {
    url = new URL(location.href);
  } catch {
    return null;
  }
  if (!url.searchParams.has("token")) return null;
  const token = (url.searchParams.get("token") ?? "").trim();
  url.searchParams.delete("token");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return TOKEN_PATTERN.test(token) ? token : null;
}

export type ResetPasswordFields = { newPassword: string; confirmPassword: string };
export type ResetPasswordFieldErrors = Partial<Record<keyof ResetPasswordFields, string>>;

/** The rules every role shares; the server applies its role-specific rules again. */
export function checkResetPasswordFields(values: ResetPasswordFields): ResetPasswordFieldErrors {
  const errors: ResetPasswordFieldErrors = {};
  const { newPassword, confirmPassword } = values;
  if (newPassword.length === 0) errors.newPassword = PASSWORD_MESSAGES.newRequired;
  else if (newPassword.length < STUDENT_PASSWORD_MIN_LENGTH) errors.newPassword = PASSWORD_MESSAGES.tooShort;
  else if (newPassword.length > STUDENT_PASSWORD_MAX_LENGTH) errors.newPassword = PASSWORD_MESSAGES.tooLong;
  else if (utf8ByteLength(newPassword) > STUDENT_PASSWORD_MAX_BYTES) errors.newPassword = PASSWORD_MESSAGES.tooManyBytes;

  if (confirmPassword.length === 0) errors.confirmPassword = PASSWORD_MESSAGES.confirmRequired;
  else if (confirmPassword !== newPassword) errors.confirmPassword = PASSWORD_MESSAGES.mismatch;
  return errors;
}

export const RESET_CONFIRM_MESSAGES = {
  done: "Your password has been reset. You have been signed out everywhere — sign in with your new password.",
  invalidLink: "This reset link is invalid, has expired or has already been used. Request a new link and try again.",
  conflict: "Your password could not be reset. Please try again.",
  failed: "Unable to reset your password right now. Please try again.",
  network: "Unable to reach the server. Check your connection and try again.",
} as const;

export type ResetConfirmOutcome =
  | { kind: "done" }
  | { kind: "invalid-link" }
  | { kind: "error"; message: string; field: keyof ResetPasswordFields | null };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function waitText(retryAfter: string | null): string {
  const seconds = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return "Please wait a few minutes and try again.";
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Please wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`;
}

/** Maps the API answer: fixed text, except the server's password-validation message. */
export function mapResetConfirmResponse(status: number, payload: unknown, retryAfter: string | null): ResetConfirmOutcome {
  if (status >= 200 && status < 300 && isObject(payload) && payload.success === true) return { kind: "done" };
  const error = isObject(payload) && isObject(payload.error) ? payload.error : {};
  const code = typeof error.code === "string" ? error.code : "";
  const serverMessage = typeof error.message === "string" ? error.message : "";

  if (code === "INVALID_RESET_TOKEN") return { kind: "invalid-link" };
  if (status === 429) return { kind: "error", message: `Too many attempts. ${waitText(retryAfter)}`, field: null };
  if (status === 409) return { kind: "error", message: RESET_CONFIRM_MESSAGES.conflict, field: null };
  if (status === 400 && code === "VALIDATION_ERROR" && serverMessage) return { kind: "error", message: serverMessage, field: "newPassword" };
  return { kind: "error", message: RESET_CONFIRM_MESSAGES.failed, field: null };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Sends the token and the new password (the confirmation is checked here, not sent); never throws. */
export async function submitResetConfirm(
  token: string,
  values: ResetPasswordFields,
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
): Promise<ResetConfirmOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(PASSWORD_RESET_CONFIRM_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ token, newPassword: values.newPassword }),
    });
  } catch {
    return { kind: "error", message: RESET_CONFIRM_MESSAGES.network, field: null };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return mapResetConfirmResponse(response.status, payload, response.headers.get("retry-after"));
}

// ---- View --------------------------------------------------------------------------------------

export type ResetConfirmPhase = "loading" | "missing" | "form" | "invalid-link" | "done";

export type ResetConfirmViewProps = {
  phase: ResetConfirmPhase;
  values?: ResetPasswordFields;
  errors?: ResetPasswordFieldErrors;
  errorMessage?: string | null;
  isSubmitting?: boolean;
  onChange?: (name: keyof ResetPasswordFields, value: string) => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
};

const EMPTY: ResetPasswordFields = { newPassword: "", confirmPassword: "" };
const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 aria-[invalid=true]:border-red-400";

function RequestNewLink({ text }: { text: string }) {
  return (
    <div className="space-y-3">
      <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
        {text}
      </p>
      <Link
        href="/reset-password"
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
      >
        Request a new reset link
      </Link>
    </div>
  );
}

export function ResetConfirmView({ phase, values = EMPTY, errors = {}, errorMessage = null, isSubmitting = false, onChange, onSubmit }: ResetConfirmViewProps) {
  if (phase === "loading") {
    return (
      <p role="status" className="text-[12px] text-slate-500">
        Checking your reset link...
      </p>
    );
  }
  if (phase === "missing") {
    return <RequestNewLink text="This reset link is incomplete. Open the link from your email again, or request a new one." />;
  }
  if (phase === "invalid-link") {
    return <RequestNewLink text={RESET_CONFIRM_MESSAGES.invalidLink} />;
  }
  if (phase === "done") {
    return (
      <div className="space-y-3">
        <p role="status" className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
          {RESET_CONFIRM_MESSAGES.done}
        </p>
        <Link
          href="/login"
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
        >
          Sign in
        </Link>
      </div>
    );
  }

  const field = (name: keyof ResetPasswordFields, label: string) => {
    const error = errors[name];
    return (
      <div>
        <label htmlFor={name} className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {label}
        </label>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            id={name}
            name={name}
            type="password"
            required
            autoComplete="new-password"
            maxLength={STUDENT_PASSWORD_MAX_LENGTH}
            value={values[name]}
            onChange={(event) => onChange?.(name, event.target.value)}
            disabled={isSubmitting}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${name}-error` : name === "newPassword" ? "newPassword-help" : undefined}
            className={inputClass}
          />
        </div>
        {error ? (
          <p id={`${name}-error`} role="alert" className="mt-1 text-[12px] text-red-700">
            {error}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <form className="space-y-3.5" onSubmit={onSubmit} noValidate>
      {field("newPassword", "New password")}
      {field("confirmPassword", "Confirm new password")}
      <p id="newPassword-help" className="text-[11px] text-slate-500">
        {STUDENT_PASSWORD_MIN_LENGTH}–{STUDENT_PASSWORD_MAX_LENGTH} characters. Teacher accounts: include an uppercase letter, a lowercase
        letter and a number.
      </p>

      {errorMessage ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {errorMessage}
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
  );
}

// ---- Container ---------------------------------------------------------------------------------

export function ResetConfirmForm() {
  const [phase, setPhase] = useState<ResetConfirmPhase>("loading");
  const [values, setValues] = useState<ResetPasswordFields>(EMPTY);
  const [errors, setErrors] = useState<ResetPasswordFieldErrors>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // The token: component memory only (a ref: never rendered, never stored).
  const tokenRef = useRef<string | null>(null);
  const tokenRead = useRef(false);
  const inFlight = useRef(false);

  useEffect(() => {
    // Once per page load (React may run effects twice in development).
    if (tokenRead.current) return;
    tokenRead.current = true;
    tokenRef.current = takeResetTokenFromLocation(window.location, window.history);
    setPhase(tokenRef.current ? "form" : "missing");
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setErrorMessage(null);

    const found = checkResetPasswordFields(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const token = tokenRef.current;
    if (!token) {
      setPhase("missing");
      return;
    }

    inFlight.current = true;
    setIsSubmitting(true);
    try {
      const outcome = await submitResetConfirm(token, values);
      if (outcome.kind === "done" || outcome.kind === "invalid-link") {
        tokenRef.current = null;
        setValues(EMPTY);
        setErrors({});
        setPhase(outcome.kind);
        return;
      }
      if (outcome.field) setErrors({ [outcome.field]: outcome.message });
      else setErrorMessage(outcome.message);
    } finally {
      inFlight.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <ResetConfirmView
      phase={phase}
      values={values}
      errors={errors}
      errorMessage={errorMessage}
      isSubmitting={isSubmitting}
      onChange={(name, value) => {
        setValues((current) => ({ ...current, [name]: value }));
        setErrors((current) => ({ ...current, [name]: undefined }));
      }}
      onSubmit={handleSubmit}
    />
  );
}
