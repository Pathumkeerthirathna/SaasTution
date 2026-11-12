/*
 * Request bodies of the class create / edit forms
 * (components/class-management-panel.tsx), framework-free so they can be
 * tested. Stage 5.7b-2b-3 adds the class's default attendance grace period;
 * every existing field is sent exactly as before (the form's own fields,
 * monthlyFee and paymentDueWeek as numbers).
 *
 * The grace period is the text of a number input: whole minutes 0–240 (0 is
 * valid), checked before anything is sent; it is always sent as a number
 * (never null / undefined). The server validates again.
 */

import { GRACE_MINUTES_DEFAULT, graceInputProblemMessage, parseGraceMinutesInput } from "@/components/attendance/attendance-ui";

/** The fields every class form has (the panel's FormState). */
export type ClassFormFields = {
  name: string;
  description: string;
  monthlyFee: string;
  paymentDueWeek: string;
  /** The grace input's text (whole minutes 0–240). */
  attendanceGraceMinutes: string;
  startDate: string;
  schedules: { dayOfWeek: string; startTime: string; endTime: string }[];
};

/** A new class starts at the default (10 minutes). */
export const DEFAULT_CLASS_GRACE_INPUT = String(GRACE_MINUTES_DEFAULT);

/** An existing class's saved value as the input's text (the default only if the API did not send one). */
export function classGraceInput(saved: number | null | undefined): string {
  return typeof saved === "number" && Number.isInteger(saved) ? String(saved) : DEFAULT_CLASS_GRACE_INPUT;
}

export type ClassFormBody = Omit<ClassFormFields, "monthlyFee" | "paymentDueWeek" | "attendanceGraceMinutes"> & {
  monthlyFee: number;
  paymentDueWeek: number;
  attendanceGraceMinutes: number;
};

export type ClassFormPayload = { ok: true; body: ClassFormBody } | { ok: false; message: string };

/** The create / update body (the two forms send the same shape), or the grace input's problem. */
export function buildClassFormPayload(form: ClassFormFields): ClassFormPayload {
  const grace = parseGraceMinutesInput(form.attendanceGraceMinutes);
  if (!grace.ok) return { ok: false, message: graceInputProblemMessage(grace.problem) };
  return {
    ok: true,
    body: {
      ...form,
      monthlyFee: Number(form.monthlyFee || 0),
      paymentDueWeek: Number(form.paymentDueWeek || 1),
      attendanceGraceMinutes: grace.value,
    },
  };
}
