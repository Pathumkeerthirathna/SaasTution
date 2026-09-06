export const MONTH_KEY_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
export const PAYMENT_DUE_WEEKS = [1, 2, 3, 4] as const;
export type PaymentDueWeek = (typeof PAYMENT_DUE_WEEKS)[number];

export const ALLOWED_PAYMENT_PROOF_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export const MAX_PAYMENT_PROOF_SIZE_BYTES = 10 * 1024 * 1024;

export function isValidMonthKey(value: string) {
  return MONTH_KEY_REGEX.test(value);
}

export function getCurrentMonthKey() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}`;
}

export function isValidPaymentDueWeek(value: unknown): value is PaymentDueWeek {
  return typeof value === "number" && PAYMENT_DUE_WEEKS.includes(value as PaymentDueWeek);
}

export function getPaymentWeekLabel(week: PaymentDueWeek) {
  if (week === 1) return "First week";
  if (week === 2) return "Second week";
  if (week === 3) return "Third week";
  return "Fourth week";
}

/**
 * Built from UTC calendar fields (not the server's local timezone) so the
 * result lines up with `nowInSriLanka()`, which shifts the current instant
 * onto Sri Lankan wall-clock time and exposes it via the UTC getters.
 */
export function getPaymentDueDate(monthKey: string, week: PaymentDueWeek) {
  const [yearPart, monthPart] = monthKey.split("-").map((value) => Number(value));
  const day = week * 7;
  return new Date(Date.UTC(yearPart, monthPart - 1, day, 23, 59, 59, 999));
}

export const PAYMENT_DUE_SOON_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

export type PaymentDueStatus = "OVERDUE" | "DUE_SOON" | "UPCOMING";

/** `now` must be Sri Lankan wall-clock time, e.g. from `nowInSriLanka()`. */
export function getPaymentDueStatus(dueDate: Date, now: Date): PaymentDueStatus {
  const msUntilDue = dueDate.getTime() - now.getTime();
  if (msUntilDue < 0) return "OVERDUE";
  if (msUntilDue <= PAYMENT_DUE_SOON_WINDOW_MS) return "DUE_SOON";
  return "UPCOMING";
}

export function sanitizeUploadFileName(fileName: string) {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
