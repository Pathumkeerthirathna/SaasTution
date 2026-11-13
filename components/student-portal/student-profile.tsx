"use client";

/*
 * The student's own profile page (Student Profile SP-2 / SP-3). Loads
 * GET /api/students/me/profile (the student comes from the session; nothing
 * identifying is sent). The phone number (`contact01`) is the only editable
 * field (SP-3: PATCH /api/students/me/profile with exactly { contact01 });
 * the name is managed by the teacher and every other field is read only.
 * SP-4: the student's attendance QR (display-only) is shown below the details.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, BadgeCheck, CalendarDays, CheckCircle2, Hash, Loader2, Lock, Mail, Pencil, Phone, RefreshCw, ShieldAlert, UserRound } from "lucide-react";

import { StudentQrPanel } from "@/components/student-portal/student-qr-panel";
import { Panel } from "@/components/student-portal/student-ui";
import { studentPhoneSchema } from "@/lib/student-profile-validation";

export type StudentProfileData = {
  name: string;
  registrationNumber: string | null;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  registeredOn: string | null;
};

export type ProfileLoadError = { status: number; code: string; message: string };
export type ProfileLoadResult = { ok: true; profile: StudentProfileData } | ({ ok: false } & ProfileLoadError);

export const PROFILE_ENDPOINT = "/api/students/me/profile";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const optionalString = (value: unknown) => value === null || typeof value === "string";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The response's data, checked field by field; anything else is null. */
export function readStudentProfile(data: unknown): StudentProfileData | null {
  if (!isObject(data)) return null;
  if (typeof data.name !== "string" || typeof data.emailVerified !== "boolean") return null;
  if (!optionalString(data.registrationNumber) || !optionalString(data.email) || !optionalString(data.phone) || !optionalString(data.registeredOn)) return null;
  if (typeof data.registeredOn === "string" && !DATE_ONLY.test(data.registeredOn)) return null;
  return {
    name: data.name,
    registrationNumber: data.registrationNumber as string | null,
    email: data.email as string | null,
    emailVerified: data.emailVerified,
    phone: data.phone as string | null,
    registeredOn: data.registeredOn as string | null,
  };
}

const MESSAGES: Record<string, string> = {
  UNAUTHORIZED: "Your session has expired. Please sign in again.",
  STUDENT_NOT_FOUND: "Your student account could not be found. Please sign in again or contact your teacher.",
  STUDENT_ACCOUNT_INACTIVE: "Your student account is inactive. Please contact your teacher.",
  NETWORK_ERROR: "Could not reach the server. Check your connection and try again.",
  INVALID_RESPONSE: "The server sent an unexpected response. Please try again.",
  SERVER_ERROR: "Something went wrong while loading your profile. Please try again.",
};

/** Loads the profile; never throws. Error messages are fixed text (never server internals). */
export async function loadStudentProfile(options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {}): Promise<ProfileLoadResult> {
  const fetchImpl = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(PROFILE_ENDPOINT, { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" }, signal: options.signal });
  } catch {
    return { ok: false, status: 0, code: "NETWORK_ERROR", message: MESSAGES.NETWORK_ERROR };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.ok && isObject(payload) && payload.success === true) {
    const profile = readStudentProfile(payload.data);
    return profile ? { ok: true, profile } : { ok: false, status: response.status, code: "INVALID_RESPONSE", message: MESSAGES.INVALID_RESPONSE };
  }
  const code = isObject(payload) && isObject(payload.error) && typeof payload.error.code === "string" ? payload.error.code : "";
  if (response.status === 401) return { ok: false, status: 401, code: "UNAUTHORIZED", message: MESSAGES.UNAUTHORIZED };
  if (MESSAGES[code]) return { ok: false, status: response.status, code, message: MESSAGES[code] };
  return { ok: false, status: response.status, code: response.status >= 500 ? "SERVER_ERROR" : "INVALID_RESPONSE", message: response.status >= 500 ? MESSAGES.SERVER_ERROR : MESSAGES.INVALID_RESPONSE };
}

/** "25 Jul 2026" from a YYYY-MM-DD calendar date (no time zone conversion). */
export function formatRegistrationDate(value: string | null): string {
  if (!value || !DATE_ONLY.test(value)) return "Not available";
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return "Not available";
  return date.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

// ---- Phone number editing (SP-3) -------------------------------------------------------------

export type PhoneSaveResult =
  | { ok: true; profile: StudentProfileData }
  | { ok: false; status: number; code: string; message: string; field: string | null };

const SAVE_MESSAGES: Record<string, string> = {
  UNAUTHORIZED: "Your session has expired. Please sign in again to save your phone number.",
  PROFILE_UPDATE_RATE_LIMITED: "Too many changes in a short time. Please wait a few minutes and try again.",
  STUDENT_ACCOUNT_INACTIVE: "Your student account is inactive. Please contact your teacher.",
  STUDENT_NOT_FOUND: "Your student account could not be found. Please sign in again.",
  CROSS_ORIGIN_REQUEST_REJECTED: "This request was blocked for security. Reload the page and try again.",
  NETWORK_ERROR: "Could not reach the server. Your phone number was not changed. Try again.",
  SERVER_ERROR: "Something went wrong. Your phone number was not changed. Try again.",
};

/** Client-side check with the server's own rule (the server decides again). */
export function checkPhoneInput(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const parsed = studentPhoneSchema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: parsed.error.issues[0]?.message ?? "Please enter a valid phone number." };
}

/** PATCH the phone number: the body is exactly { contact01 }; never throws; fixed messages except the server's field validation text. */
export async function submitStudentPhone(contact01: string, options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {}): Promise<PhoneSaveResult> {
  const fetchImpl = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(PROFILE_ENDPOINT, {
      method: "PATCH",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ contact01 }),
      signal: options.signal,
    });
  } catch {
    return { ok: false, status: 0, code: "NETWORK_ERROR", message: SAVE_MESSAGES.NETWORK_ERROR, field: null };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.ok && isObject(payload) && payload.success === true) {
    const profile = readStudentProfile(payload.data);
    if (profile) return { ok: true, profile };
    return { ok: false, status: response.status, code: "SERVER_ERROR", message: SAVE_MESSAGES.SERVER_ERROR, field: null };
  }
  const error = isObject(payload) && isObject(payload.error) ? payload.error : null;
  const code = error && typeof error.code === "string" ? error.code : "";
  const field = error && isObject(error.details) && typeof error.details.field === "string" ? error.details.field : null;
  if (response.status === 401) return { ok: false, status: 401, code: "UNAUTHORIZED", message: SAVE_MESSAGES.UNAUTHORIZED, field: null };
  if (response.status === 400 && code === "VALIDATION_ERROR" && field === "contact01" && error && typeof error.message === "string") {
    // The server's validation message for the field is fixed text (lib/student-profile-validation.ts).
    return { ok: false, status: 400, code, message: error.message, field };
  }
  if (SAVE_MESSAGES[code]) return { ok: false, status: response.status, code, message: SAVE_MESSAGES[code], field: null };
  return { ok: false, status: response.status, code: "SERVER_ERROR", message: SAVE_MESSAGES.SERVER_ERROR, field: null };
}

export type PhoneEditState =
  | { mode: "view" }
  | { mode: "edit"; draft: string; problem: string | null; submitting: boolean; signIn: boolean };

export const PHONE_INPUT_ID = "student-profile-phone";
export const PHONE_EDIT_BUTTON_ID = "student-profile-phone-edit";

export type PhoneFieldProps = {
  phone: string | null;
  state: PhoneEditState;
  onEdit: () => void;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
};

/** The phone number: shown with an Edit action, or a small form while editing. */
export function PhoneField({ phone, state, onEdit, onDraftChange, onSave, onCancel }: PhoneFieldProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave();
  };
  if (state.mode === "view") {
    return (
      <div className="flex min-w-0 items-start gap-3 rounded-xl border border-brand-100 bg-brand-50/40 p-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-700" aria-hidden>
          <Phone size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <dt className="text-[11px] font-bold uppercase tracking-widest text-muted">Phone</dt>
          <dd className="mt-1 flex flex-wrap items-center justify-between gap-2 break-words text-sm font-medium text-foreground">
            <span>{phone ?? notProvided}</span>
            <button
              type="button"
              id={PHONE_EDIT_BUTTON_ID}
              onClick={onEdit}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50"
            >
              <Pencil size={12} aria-hidden />
              Edit
              <span className="sr-only"> phone number</span>
            </button>
          </dd>
        </div>
      </div>
    );
  }
  const describedBy = state.problem ? "student-profile-phone-help student-profile-phone-error" : "student-profile-phone-help";
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-xl border border-brand-300 bg-white p-3 sm:col-span-2">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-700" aria-hidden>
        <Phone size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <dt className="text-[11px] font-bold uppercase tracking-widest text-muted">
          <label htmlFor={PHONE_INPUT_ID}>Phone</label>
        </dt>
        <dd className="mt-1">
          <form onSubmit={submit} noValidate className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">
              <input
                id={PHONE_INPUT_ID}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={state.draft}
                onChange={(event) => onDraftChange(event.target.value)}
                disabled={state.submitting}
                aria-invalid={state.problem ? true : undefined}
                aria-describedby={describedBy}
                className="min-h-[44px] w-full rounded-xl border border-brand-200 px-3 py-2 text-sm text-foreground outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:bg-slate-50"
              />
              <p id="student-profile-phone-help" className="mt-1 text-xs text-muted">
                Digits, spaces, + and - only (9–20 characters).
              </p>
              {state.problem ? (
                <p id="student-profile-phone-error" role="alert" className="mt-1 text-sm font-medium text-rose-700">
                  {state.problem}
                  {state.signIn ? (
                    <>
                      {" "}
                      <Link href="/login" className="font-semibold underline">
                        Sign in
                      </Link>
                    </>
                  ) : null}
                </p>
              ) : null}
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={state.submitting}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {state.submitting ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
                {state.submitting ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={onCancel}
                disabled={state.submitting}
                className="inline-flex min-h-[44px] items-center rounded-xl border border-brand-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </form>
        </dd>
      </div>
    </div>
  );
}

/**
 * The phone editing flow, framework-free (tested without React): one save at
 * a time (a second Save while one is in flight sends nothing), the local
 * check first (nothing sent when it fails), the profile replaced only from
 * the server's answer, the form kept open with the reason on any failure.
 */
export function createPhoneEditor(deps: {
  getState: () => PhoneEditState;
  setState: (state: PhoneEditState) => void;
  onSaved: (profile: StudentProfileData) => void;
  submit?: (value: string) => Promise<PhoneSaveResult>;
}) {
  const submit = deps.submit ?? ((value: string) => submitStudentPhone(value));
  let inFlight = false;
  return {
    async save(): Promise<"SAVED" | "INVALID" | "FAILED" | "IGNORED"> {
      const state = deps.getState();
      if (state.mode !== "edit" || inFlight) return "IGNORED";
      const check = checkPhoneInput(state.draft);
      if (!check.ok) {
        deps.setState({ ...state, problem: check.message, signIn: false });
        return "INVALID";
      }
      inFlight = true;
      deps.setState({ ...state, submitting: true, problem: null, signIn: false });
      try {
        const result = await submit(check.value);
        if (result.ok) {
          deps.onSaved(result.profile);
          deps.setState({ mode: "view" });
          return "SAVED";
        }
        const current = deps.getState();
        const draft = current.mode === "edit" ? current.draft : state.draft;
        deps.setState({ mode: "edit", draft, submitting: false, problem: result.message, signIn: result.code === "UNAUTHORIZED" || result.code === "STUDENT_NOT_FOUND" });
        return "FAILED";
      } finally {
        inFlight = false;
      }
    },
    isSaving: () => inFlight,
  };
}


// ---- Views (pure) ---------------------------------------------------------------------------

export function ProfileLoadingView() {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-2xl border border-brand-200 bg-white p-6 text-sm text-muted shadow-card">
      <RefreshCw size={16} className="animate-spin text-brand-600" aria-hidden />
      Loading your profile…
    </div>
  );
}

export function ProfileErrorView({ error, onRetry }: { error: ProfileLoadError; onRetry?: () => void }) {
  const signIn = error.code === "UNAUTHORIZED" || error.code === "STUDENT_NOT_FOUND";
  const retryable = error.code === "NETWORK_ERROR" || error.code === "SERVER_ERROR" || error.code === "INVALID_RESPONSE";
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-2xl border border-rose-200 bg-white p-6 text-center shadow-card sm:p-8">
      <span className="text-rose-600">{error.code === "STUDENT_ACCOUNT_INACTIVE" ? <ShieldAlert size={24} aria-hidden /> : <AlertTriangle size={24} aria-hidden />}</span>
      <p className="text-base font-semibold text-foreground">Your profile could not be loaded</p>
      <p className="max-w-md text-sm text-muted">{error.message}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {retryable && onRetry ? (
          <button type="button" onClick={onRetry} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
            <RefreshCw size={14} aria-hidden />
            Try again
          </button>
        ) : null}
        {signIn ? (
          <Link href="/login" className="inline-flex min-h-[44px] items-center rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
            Sign in
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function Field({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-xl border border-brand-100 bg-brand-50/40 p-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-700" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="text-[11px] font-bold uppercase tracking-widest text-muted">{label}</dt>
        <dd className="mt-1 break-words text-sm font-medium text-foreground">{children}</dd>
      </div>
    </div>
  );
}

const notProvided = <span className="font-normal text-muted">Not provided</span>;

export function ProfileView({ profile, phoneEditor }: { profile: StudentProfileData; phoneEditor?: PhoneFieldProps }) {
  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="student-profile-name" className="flex flex-col gap-4 rounded-2xl border border-brand-200 bg-gradient-to-r from-brand-50 to-white p-4 shadow-card sm:flex-row sm:items-center sm:p-6">
        <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-800 text-xl font-bold text-white" aria-hidden>
          {initialsOf(profile.name)}
        </span>
        <div className="min-w-0">
          <h2 id="student-profile-name" className="break-words text-xl font-bold text-foreground sm:text-2xl">
            {profile.name}
          </h2>
          <p className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
            <Lock size={12} aria-hidden />
            Name managed by your teacher
          </p>
          {profile.registrationNumber ? (
            <p className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-700 sm:ml-2">
              <Hash size={12} aria-hidden />
              {profile.registrationNumber}
            </p>
          ) : null}
        </div>
      </section>

      <Panel title="Profile details" subtitle="Your student account information.">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field icon={<UserRound size={16} />} label="Name">
            {profile.name}
            <span className="block text-xs font-normal text-muted">Managed by your teacher. Contact your teacher if it needs to be corrected.</span>
          </Field>
          <Field icon={<Hash size={16} />} label="Student ID">
            {profile.registrationNumber ?? notProvided}
          </Field>
          <Field icon={<Mail size={16} />} label="Email">
            {profile.email ?? notProvided}
            {profile.email ? (
              <span
                className={`mt-1 inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${
                  profile.emailVerified ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-amber-50 text-amber-900 ring-amber-200"
                }`}
              >
                {profile.emailVerified ? <BadgeCheck size={12} aria-hidden /> : <AlertTriangle size={12} aria-hidden />}
                {profile.emailVerified ? "Verified" : "Not verified"}
              </span>
            ) : null}
          </Field>
          {phoneEditor ? (
            <PhoneField {...phoneEditor} />
          ) : (
            <Field icon={<Phone size={16} />} label="Phone">
              {profile.phone ?? notProvided}
            </Field>
          )}
          <Field icon={<CalendarDays size={16} />} label="Registration date">
            {formatRegistrationDate(profile.registeredOn)}
          </Field>
        </dl>
        <p className="mt-4 text-sm text-muted">
          Your password is managed in{" "}
          <Link href="/student/settings" className="font-semibold text-brand-700 underline-offset-2 hover:underline">
            Settings
          </Link>
          .
        </p>
      </Panel>
    </div>
  );
}

// ---- The panel (state) -------------------------------------------------------------------------

type PanelState = { kind: "loading" } | { kind: "error"; error: ProfileLoadError } | { kind: "ready"; profile: StudentProfileData };

export function StudentProfilePanel() {
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const [phoneState, setPhoneStateValue] = useState<PhoneEditState>({ mode: "view" });
  const [notice, setNotice] = useState<string | null>(null);
  const phoneStateRef = useRef<PhoneEditState>({ mode: "view" });
  const mounted = useRef(true);

  const setPhoneState = useCallback((next: PhoneEditState) => {
    if (!mounted.current) return;
    phoneStateRef.current = next;
    setPhoneStateValue(next);
  }, []);

  const editor = useRef(
    createPhoneEditor({
      getState: () => phoneStateRef.current,
      setState: (next) => setPhoneState(next),
      onSaved: (profile) => {
        if (!mounted.current) return;
        setState({ kind: "ready", profile });
        setNotice("Your phone number was updated.");
      },
    })
  );

  const load = useCallback((signal?: AbortSignal) => {
    setState({ kind: "loading" });
    void loadStudentProfile({ signal }).then((result) => {
      if (signal?.aborted) return;
      setState(result.ok ? { kind: "ready", profile: result.profile } : { kind: "error", error: { status: result.status, code: result.code, message: result.message } });
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    load(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [load]);

  // Focus: into the input when editing starts; back to Edit when it ends.
  const editing = phoneState.mode === "edit";
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing && !wasEditing.current) document.getElementById(PHONE_INPUT_ID)?.focus();
    if (!editing && wasEditing.current) document.getElementById(PHONE_EDIT_BUTTON_ID)?.focus();
    wasEditing.current = editing;
  }, [editing]);

  if (state.kind === "loading") return <ProfileLoadingView />;
  if (state.kind === "error") return <ProfileErrorView error={state.error} onRetry={() => load()} />;

  const profile = state.profile;
  return (
    <div className="flex flex-col gap-3">
      {notice ? (
        <p role="status" className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-900">
          <CheckCircle2 size={16} aria-hidden />
          {notice}
        </p>
      ) : null}
      <ProfileView
        profile={profile}
        phoneEditor={{
          phone: profile.phone,
          state: phoneState,
          onEdit: () => {
            setNotice(null);
            setPhoneState({ mode: "edit", draft: profile.phone ?? "", problem: null, submitting: false, signIn: false });
          },
          onDraftChange: (value) => {
            const current = phoneStateRef.current;
            if (current.mode === "edit" && !current.submitting) setPhoneState({ ...current, draft: value, problem: null, signIn: false });
          },
          onSave: () => void editor.current.save(),
          onCancel: () => {
            if (!editor.current.isSaving()) setPhoneState({ mode: "view" });
          },
        }}
      />
      <StudentQrPanel studentName={profile.name} registrationNumber={profile.registrationNumber} />
    </div>
  );
}
