"use client";

import { useRef, useState, type FormEvent } from "react";
import { CheckCircle2, IdCard, Send } from "lucide-react";

import { REGISTRATION_NUMBER_MAX_LENGTH, REGISTRATION_NUMBER_TOO_LONG_MESSAGE } from "@/lib/student-validation";

/*
 * "Reset your password" request form (Student Profile SP-7E), shared by
 * every role on /reset-password — there is no role selection: the server
 * (SP-7C) decides by what matches. Students identify themselves by
 * REGISTRATION NUMBER only (their email is no reset identifier); teachers
 * and guardians by email, as before.
 *
 * Client checks mirror the server's form rules only: required, at most 254
 * characters, and — for an entry without "@" (a registration number) — at
 * most 64 characters in its normalized (trimmed, upper-case) form. The
 * server decides everything again. Every answer for a well-formed request
 * is the same generic message: nothing here can tell whether an account
 * exists, has an email, or the email was delivered.
 */

export const PASSWORD_RESET_REQUEST_ENDPOINT = "/api/auth/password-reset/request";
/** The server's limit for the identifier (lib/password-reset-request-http.ts). */
export const RESET_LOGIN_ID_MAX_LENGTH = 254;

export const RESET_REQUEST_MESSAGES = {
  required: "Enter your registration number or email address.",
  tooLong: "That entry is too long. Check your registration number or email address.",
  registrationTooLong: REGISTRATION_NUMBER_TOO_LONG_MESSAGE,
  generic: "If an account exists, a reset link has been sent to the registered email address.",
  crossOrigin: "This request was blocked for security. Reload the page and try again.",
  failed: "Unable to request a password reset right now. Please try again later.",
  network: "Unable to reach the server. Check your connection and try again.",
} as const;

/** The form's client check; null when the entry can be sent. */
export function checkResetRequestInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return RESET_REQUEST_MESSAGES.required;
  if (trimmed.length > RESET_LOGIN_ID_MAX_LENGTH) return RESET_REQUEST_MESSAGES.tooLong;
  // No "@": a registration number, measured as the server measures it.
  if (!trimmed.includes("@") && trimmed.toUpperCase().length > REGISTRATION_NUMBER_MAX_LENGTH) {
    return RESET_REQUEST_MESSAGES.registrationTooLong;
  }
  return null;
}

export type ResetRequestOutcome = { ok: true; message: string } | { ok: false; message: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function waitText(retryAfter: string | null): string {
  const seconds = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return "Please wait a few minutes and try again.";
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Please wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`;
}

/** Maps the API answer to what the form shows: fixed text, except the server's form-validation message. */
export function mapResetRequestResponse(status: number, payload: unknown, retryAfter: string | null): ResetRequestOutcome {
  if (status >= 200 && status < 300 && isObject(payload) && payload.success === true) {
    return { ok: true, message: RESET_REQUEST_MESSAGES.generic };
  }
  const error = isObject(payload) && isObject(payload.error) ? payload.error : {};
  const code = typeof error.code === "string" ? error.code : "";
  const serverMessage = typeof error.message === "string" ? error.message : "";

  if (status === 429) return { ok: false, message: `Too many reset requests. ${waitText(retryAfter)}` };
  if (code === "CROSS_ORIGIN_REQUEST_REJECTED") return { ok: false, message: RESET_REQUEST_MESSAGES.crossOrigin };
  if (status === 413) return { ok: false, message: RESET_REQUEST_MESSAGES.tooLong };
  if (status === 400 && code === "VALIDATION_ERROR" && serverMessage) return { ok: false, message: serverMessage };
  return { ok: false, message: RESET_REQUEST_MESSAGES.failed };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Sends the trimmed entry; never throws. */
export async function submitResetRequest(value: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)): Promise<ResetRequestOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(PASSWORD_RESET_REQUEST_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ loginId: value.trim() }),
    });
  } catch {
    return { ok: false, message: RESET_REQUEST_MESSAGES.network };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return mapResetRequestResponse(response.status, payload, response.headers.get("retry-after"));
}

export type ResetRequestViewProps = {
  value: string;
  onChange?: (value: string) => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  isSubmitting?: boolean;
  fieldError?: string | null;
  errorMessage?: string | null;
  message?: string | null;
};

export function ResetRequestView({ value, onChange, onSubmit, isSubmitting = false, fieldError = null, errorMessage = null, message = null }: ResetRequestViewProps) {
  return (
    <form className="space-y-3.5" onSubmit={onSubmit} noValidate>
      <div>
        <label htmlFor="loginId" className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Registration number or email
        </label>
        <div className="relative">
          <IdCard className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            id="loginId"
            name="loginId"
            type="text"
            required
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={RESET_LOGIN_ID_MAX_LENGTH}
            value={value}
            onChange={(event) => onChange?.(event.target.value)}
            disabled={isSubmitting}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? "loginId-help loginId-error" : "loginId-help"}
            className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 aria-[invalid=true]:border-red-400"
            placeholder="ABC-2026-001 or teacher@school.com"
          />
        </div>
        <p id="loginId-help" className="mt-1 text-[11px] text-slate-500">
          Students: enter your registration number. Teachers and guardians: enter your email address.
        </p>
        {fieldError ? (
          <p id="loginId-error" role="alert" className="mt-1 text-[12px] text-red-700">
            {fieldError}
          </p>
        ) : null}
      </div>

      {errorMessage ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {errorMessage}
        </p>
      ) : null}

      {message ? (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
          {message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={isSubmitting}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 focus:ring-2 focus:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Send className="h-4 w-4" />
        {isSubmitting ? "Sending link..." : "Send reset link"}
      </button>
    </form>
  );
}

export function ResetRequestForm() {
  const [value, setValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setErrorMessage(null);
    setMessage(null);

    const problem = checkResetRequestInput(value);
    setFieldError(problem);
    if (problem) return;

    inFlight.current = true;
    setIsSubmitting(true);
    try {
      const outcome = await submitResetRequest(value);
      if (outcome.ok) {
        setMessage(outcome.message);
        setValue("");
      } else {
        setErrorMessage(outcome.message);
      }
    } finally {
      inFlight.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <ResetRequestView
      value={value}
      onChange={(next) => {
        setValue(next);
        setFieldError(null);
      }}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      fieldError={fieldError}
      errorMessage={errorMessage}
      message={message}
    />
  );
}
