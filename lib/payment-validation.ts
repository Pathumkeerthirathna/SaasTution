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

export function getPaymentDueDate(monthKey: string, week: PaymentDueWeek) {
  const [yearPart, monthPart] = monthKey.split("-").map((value) => Number(value));
  const day = week * 7;
  return new Date(yearPart, monthPart - 1, day, 23, 59, 59, 999);
}

export function sanitizeUploadFileName(fileName: string) {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
