/*
 * Error-log sanitizing, shared by the browser reporter and the server logger
 * (no Node or DOM imports). Everything that reaches a log goes through here:
 * secrets, tokens and personal data are replaced, URLs and paths lose their
 * query strings, control characters are removed, and every field has a
 * length limit.
 *
 * Plain regular expressions only (no lookbehind): this module is part of the
 * browser bundle, and older Safari versions cannot even parse lookbehind.
 * Every pattern runs in linear time (bounded repetitions), and only on input
 * already cut to the field's limit, so hostile input cannot make it slow.
 */

export const ERROR_LOG_LIMITS = {
  name: 120,
  message: 1000,
  stack: 8000,
  route: 300,
  digest: 120,
  kind: 60,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Control characters (C0 except tab and newline, DEL, C1) and Unicode
// direction overrides: they could rewrite a terminal or hide text when a
// log is read with `cat` / `jq -r`.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

// A token-like run: redacted when it mixes letters and digits; record IDs
// (UUIDs) and long ordinary words stay readable.
function redactLongToken(match: string) {
  if (UUID.test(match) || !/[0-9]/.test(match) || !/[A-Za-z]/.test(match)) {
    return match;
  }

  return "[REDACTED_TOKEN]";
}

type TextRule = [RegExp, string | ((match: string, ...groups: string[]) => string)];

// Applied in order. Query strings go first: their parameters are removed
// whole, before the key rules below rewrite parts of them.
const TEXT_RULES: TextRule[] = [
  // Query strings inside URLs (stack traces, messages).
  [/(https?:\/\/[^\s?#)'"`]{1,2048})\?[^\s#)'"`]*/g, "$1?[query]"],
  // Query strings after paths: "GET /api/x?studentId=…", "(/session/join?invite=…)".
  [/(^|[\s(=:'"`,])(\/[^\s?#)'"`]{0,2048})\?[^\s#)'"`]*/g, "$1$2?[query]"],
  // JSON Web Tokens (header.payload.signature, base64url).
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[REDACTED_JWT]"],
  // Authorization header values.
  [/\b(Bearer|Basic)\s{1,10}[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  // Cookie headers: every cookie, up to the end of the line.
  [/\b(set-cookie|cookies?)(["']?[ \t]{0,10}[:=])[^\r\n]*/gi, "$1$2 [REDACTED]"],
  // key=value / key: value / "key":"value" pairs with a sensitive key.
  [
    /((?:password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|id_token|api[_-]?key|authorization|jwt|otp|invite|signature)["']?[ \t]{0,10}[:=][ \t]{0,10}["']?)[^\s"'&,;}]+/gi,
    "$1[REDACTED]",
  ],
  // "password is hunter2"
  [/\b(password|passwd|pwd|secret|token|otp)([ \t]{1,10}(?:is|was|of)[ \t]{1,10})\S+/gi, "$1$2[REDACTED]"],
  // Email addresses (bounded parts: linear time).
  [/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g, "[REDACTED_EMAIL]"],
  // Long opaque tokens (session tokens, API keys, reset and invite codes).
  [/\b[A-Za-z0-9_-]{32,}\b/g, redactLongToken],
  // Sri Lankan NIC numbers: 9 digits + V/X (old), 12 digits (new).
  [/\b\d{9}[VvXx]\b/g, "[REDACTED_NIC]"],
  [/\b(?:19|20)\d{10}\b/g, "[REDACTED_NIC]"],
  // Phone numbers: Sri Lankan mobiles (077 123 4567, +94 77 123 4567), Sri
  // Lankan landlines (011 234 5678) and other numbers written with a leading
  // +. Not any long number: record IDs, digests and timestamps stay readable.
  [/(?:\+94[ -]?|\b0)7\d(?:[ -]?\d){7}\b/g, "[REDACTED_PHONE]"],
  [/\b0[1-689]\d[ -]?\d{3}[ -]?\d{4}\b/g, "[REDACTED_PHONE]"],
  [/\+\d{1,3}[ -]?\d(?:[ -]?\d){6,12}\b/g, "[REDACTED_PHONE]"],
];

/** Redacts sensitive values in free text and limits its length. */
export function scrubText(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }

  // Cut first: the patterns only ever see a bounded string.
  let text = value.length > maxLength ? value.slice(0, maxLength) : value;

  text = text.replace(UNSAFE_CHARACTERS, "");

  for (const [pattern, replacement] of TEXT_RULES) {
    text = text.replace(pattern, replacement as string);
  }

  // Replacements can lengthen the text a little.
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * A route for the log: the path only. The query string and fragment are
 * dropped (they can carry invite tokens, OAuth codes or student IDs) and
 * token-like path segments are replaced. Record IDs (UUIDs) are kept: they
 * are needed to investigate and are not personal data by themselves.
 */
export function sanitizeRoute(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }

  let pathname = value.trim().slice(0, 2048);

  try {
    pathname = new URL(pathname, "http://localhost").pathname;
  } catch {
    pathname = pathname.split(/[?#]/)[0] ?? "";
  }

  const segments = pathname.split("/").map((segment) => {
    if (segment.length === 0 || UUID.test(segment)) {
      return segment;
    }

    if (segment.length >= 32 || /^eyJ/.test(segment) || segment.includes("@")) {
      return ":redacted";
    }

    return segment;
  });

  return scrubText(segments.join("/"), ERROR_LOG_LIMITS.route);
}

export type NormalizedError = {
  name: string;
  message: string;
  stack?: string;
  digest?: string;
};

const SAFE_IDENTIFIER = /^[A-Za-z0-9_.]{1,64}$/;

function isPrismaError(error: unknown, name: string) {
  if (name.startsWith("PrismaClient")) return true;

  const candidate = error as { code?: unknown; clientVersion?: unknown } | null;

  return typeof candidate?.clientVersion === "string" && typeof candidate.code === "string" && /^P\d{4}$/.test(candidate.code);
}

/**
 * Prisma errors without their arguments. A PrismaClientValidationError's
 * message prints the whole query (the student's name, NIC, address…), and a
 * stack starts with that message. Kept: the error name, the code (P2002…),
 * the model / field names from `meta`, the operation ("prisma.student.create()")
 * and the message's last line, which states the problem ("Unknown argument
 * `nic`.", "Unique constraint failed on the fields: (`email`)").
 */
function prismaSummary(error: unknown, name: string, message: string, stack: string | undefined) {
  const candidate = error as { code?: unknown; meta?: Record<string, unknown> } | null;
  const parts: string[] = [];

  if (typeof candidate?.code === "string" && /^P\d{4}$/.test(candidate.code)) {
    parts.push(candidate.code);
  }

  const operation = /Invalid `(prisma\.[A-Za-z0-9_]{1,64}\.[A-Za-z0-9_]{1,64}\(\))` invocation/.exec(message)?.[1];

  if (operation) parts.push(operation);

  const meta = candidate?.meta;

  if (meta && typeof meta === "object") {
    const model = meta.modelName;
    const target = meta.target;
    const field = meta.field_name;

    if (typeof model === "string" && SAFE_IDENTIFIER.test(model)) parts.push(`model ${model}`);
    if (Array.isArray(target)) {
      const fields = target.filter((item): item is string => typeof item === "string" && SAFE_IDENTIFIER.test(item));
      if (fields.length > 0) parts.push(`fields ${fields.join(", ")}`);
    } else if (typeof target === "string" && SAFE_IDENTIFIER.test(target)) {
      parts.push(`target ${target}`);
    }
    if (typeof field === "string" && /^[A-Za-z0-9_.()` ]{1,80}$/.test(field)) parts.push(`field ${field}`);
  }

  const lastLine = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();

  const summary = [parts.join(" "), lastLine ? lastLine.slice(0, 300) : ""].filter(Boolean).join(": ");
  const frames = (stack ?? "")
    .split("\n")
    .filter((line) => /^\s+at /.test(line))
    .join("\n");

  return {
    message: summary || name,
    stack: frames ? `${name}: ${summary || name}\n${frames}` : undefined,
  };
}

/**
 * Any thrown value as name / message / stack, sanitized. Non-Error values
 * (rejected with a string or an object) are never serialized as a whole: an
 * object can hold anything, so only its `message` (if a string) is used.
 */
export function normalizeError(error: unknown): NormalizedError {
  let name = "Error";
  let message = "";
  let stack: string | undefined;
  let digest: string | undefined;

  if (error instanceof Error) {
    name = error.name || "Error";
    message = error.message;
    stack = error.stack;
  } else if (typeof error === "string") {
    name = "NonErrorThrown";
    message = error;
  } else if (error && typeof error === "object") {
    const candidate = error as { name?: unknown; message?: unknown; stack?: unknown };

    name = typeof candidate.name === "string" ? candidate.name : "NonErrorObject";
    message = typeof candidate.message === "string" ? candidate.message : `Non-Error value thrown (${Object.prototype.toString.call(error)})`;
    stack = typeof candidate.stack === "string" ? candidate.stack : undefined;
  } else {
    name = "NonErrorThrown";
    message = `Non-Error value thrown (${error === null ? "null" : typeof error})`;
  }

  if (isPrismaError(error, name)) {
    ({ message, stack } = prismaSummary(error, name, typeof message === "string" ? message.slice(0, 20_000) : "", stack?.slice(0, 40_000)));
  }

  if (error && typeof error === "object" && typeof (error as { digest?: unknown }).digest === "string") {
    digest = (error as { digest: string }).digest;
  }

  return {
    name: scrubText(name, ERROR_LOG_LIMITS.name) || "Error",
    message: scrubText(message, ERROR_LOG_LIMITS.message) || "(no message)",
    stack: stack ? scrubText(stack, ERROR_LOG_LIMITS.stack) : undefined,
    digest: digest ? scrubText(digest, ERROR_LOG_LIMITS.digest) : undefined,
  };
}

/**
 * One sanitized line for the console (PM2 logs): "Name: first line of the
 * message". Never the stack, never the raw message.
 */
export function summarizeError(error: unknown, maxLength = 300): string {
  const { name, message } = normalizeError(error);
  const firstLine = message.split("\n")[0] ?? "";

  return scrubText(`${name}: ${firstLine}`, maxLength);
}
