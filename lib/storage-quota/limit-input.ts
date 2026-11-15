/*
 * Teacher storage quota (Stage 3.4): parsing and formatting storage limits,
 * shared by the admin API (server) and the admin storage card (client). Pure:
 * no Node.js or database imports.
 *
 * Units are DECIMAL: 1 GB = 1,000,000,000 bytes (the product's convention;
 * lib/storage-quota/usage.ts). A GB value may have up to 9 decimals - exactly
 * one byte - and is converted with BigInt arithmetic, never floating point, so
 * "12.5" GB is exactly 12,500,000,000 bytes. Limits range from 0 (a real
 * limit: nothing more may be stored) to 1,000,000 GB = 10^15 bytes (1 PB, the
 * database CHECK).
 */

export const BYTES_PER_GB_DECIMAL = BigInt(1_000_000_000);
export const MAX_LIMIT_BYTES = BigInt("1000000000000000");
export const MAX_LIMIT_GB = 1_000_000;

export type LimitParseResult = { ok: true; bytes: bigint } | { ok: false; message: string };

const GB_PATTERN = /^(\d{1,7})(?:\.(\d{1,9}))?$/;
const BYTES_PATTERN = /^\d{1,16}$/;

/** "12.5" / 12.5 GB -> 12500000000n. Whole numbers, or up to 9 decimals; 0 .. 1,000,000 GB. */
export function parseStorageLimitGb(input: unknown): LimitParseResult {
  let text: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return { ok: false, message: "Enter the limit as a number of GB." };
    text = String(input); // e.g. 12.5 -> "12.5"; 1e-7 -> "1e-7" (refused below)
  } else if (typeof input === "string") {
    text = input.trim();
  } else {
    return { ok: false, message: "Enter the limit as a number of GB." };
  }
  if (text.startsWith("-")) return { ok: false, message: "The limit cannot be negative." };
  const match = GB_PATTERN.exec(text);
  if (!match) return { ok: false, message: "Enter the limit in GB as a whole number or with up to 9 decimals (e.g. 50 or 12.5)." };
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(9, "0"));
  const bytes = whole * BYTES_PER_GB_DECIMAL + fraction;
  if (bytes > MAX_LIMIT_BYTES) return { ok: false, message: `The limit can be at most ${MAX_LIMIT_GB.toLocaleString("en-US")} GB.` };
  return { ok: true, bytes };
}

/** "12500000000" bytes (a decimal string, as the API returns byte counts) -> 12500000000n. */
export function parseStorageLimitBytes(input: unknown): LimitParseResult {
  if (typeof input !== "string") return { ok: false, message: "limitBytes must be a decimal string of bytes." };
  const text = input.trim();
  if (text.startsWith("-")) return { ok: false, message: "The limit cannot be negative." };
  if (!BYTES_PATTERN.test(text)) return { ok: false, message: "limitBytes must be a whole number of bytes, as a decimal string." };
  const bytes = BigInt(text);
  if (bytes > MAX_LIMIT_BYTES) return { ok: false, message: `The limit can be at most ${MAX_LIMIT_GB.toLocaleString("en-US")} GB.` };
  return { ok: true, bytes };
}

export type StorageLimitRequest = { kind: "set"; limitBytes: bigint } | { kind: "remove" };

/**
 * The PUT /api/admin/teachers/[teacherId]/storage-limit body, exactly one of:
 *   { "limitGB": "50" | 50 }          set the individual override (decimal GB)
 *   { "limitBytes": "50000000000" }   set it in bytes (decimal string)
 *   { "removeOverride": true }        remove it (back to the plan / unlimited)
 * Any other field is refused: the teacher comes from the URL and the
 * administrator from the session, never from the body.
 */
export function parseStorageLimitRequest(body: unknown): { ok: true; value: StorageLimitRequest } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "The request body must be a JSON object." };
  const keys = Object.keys(body);
  const allowed = new Set(["limitGB", "limitBytes", "removeOverride"]);
  const unknown = keys.filter((k) => !allowed.has(k));
  if (unknown.length > 0) return { ok: false, message: `Unexpected field: ${unknown[0].slice(0, 40)}.` };
  if (keys.length !== 1) return { ok: false, message: "Send exactly one of limitGB, limitBytes or removeOverride." };
  const record = body as Record<string, unknown>;
  if ("removeOverride" in record) {
    return record.removeOverride === true ? { ok: true, value: { kind: "remove" } } : { ok: false, message: "removeOverride must be true." };
  }
  const parsed = "limitGB" in record ? parseStorageLimitGb(record.limitGB) : parseStorageLimitBytes(record.limitBytes);
  return parsed.ok ? { ok: true, value: { kind: "set", limitBytes: parsed.bytes } } : parsed;
}

// ---- Formatting --------------------------------------------------------------------------------------------

const UNITS: Array<[string, bigint]> = [
  ["PB", BigInt("1000000000000000")],
  ["TB", BigInt("1000000000000")],
  ["GB", BigInt(1_000_000_000)],
  ["MB", BigInt(1_000_000)],
  ["KB", BigInt(1_000)],
];

/** 12500000000 -> "12.5 GB" (decimal units, at most 2 decimals, rounded down; exact for any size). */
export function formatStorageBytes(value: bigint | string): string {
  const bytes = typeof value === "bigint" ? value : BigInt(value);
  for (const [unit, size] of UNITS) {
    if (bytes >= size) {
      const hundredths = (bytes * BigInt(100)) / size;
      const whole = hundredths / BigInt(100);
      const fraction = (hundredths % BigInt(100)).toString().padStart(2, "0").replace(/0+$/, "");
      return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""} ${unit}`;
    }
  }
  return `${bytes.toString()} ${bytes === BigInt(1) ? "byte" : "bytes"}`;
}

/** 12500000000 -> "12.5" (an exact GB string for an input field; trailing zeros removed). */
export function bytesToGbInput(value: bigint | string): string {
  const bytes = typeof value === "bigint" ? value : BigInt(value);
  const whole = bytes / BYTES_PER_GB_DECIMAL;
  const fraction = (bytes % BYTES_PER_GB_DECIMAL).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
