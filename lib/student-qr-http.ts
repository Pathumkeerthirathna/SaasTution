/*
 * Shared HTTP helpers for the student QR routes (app/api/students/me/qr/*).
 * Server only. Nothing here logs or returns a token, nonce, hash or secret.
 */

import QRCode from "qrcode";

import { apiError } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import type { SameOriginDecision } from "@/lib/same-origin";
import { StudentQrServiceError, type StudentQrStatus } from "@/services/student-qr-service";

/** Private, never stored by browsers, proxies or CDNs. */
export const STUDENT_QR_NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** PNG settings: 50-character payload, ~15% damage tolerance, crisp when printed. */
export const STUDENT_QR_PNG_OPTIONS = {
  type: "png",
  errorCorrectionLevel: "M",
  margin: 4,
  width: 512,
  color: { dark: "#000000", light: "#ffffff" },
} as const;

export function renderStudentQrPng(payload: string): Promise<Buffer> {
  return QRCode.toBuffer(payload, STUDENT_QR_PNG_OPTIONS);
}

/** What the student UI may know about its QR: never token material. */
export type PublicStudentQrStatus = {
  configured: boolean;
  hasActiveToken: boolean;
  regenerationLimit: number;
  regenerationsRemaining: number;
  /** ISO UTC instant; null while a regeneration is allowed. */
  nextRegenerationAt: string | null;
};

export function toPublicQrStatus(status: StudentQrStatus): PublicStudentQrStatus {
  return {
    configured: status.configured,
    hasActiveToken: status.hasActiveToken,
    regenerationLimit: status.regenerationLimit,
    regenerationsRemaining: status.regenerationsRemaining,
    nextRegenerationAt: status.nextRegenerationAt ? status.nextRegenerationAt.toISOString() : null,
  };
}

export function withNoStore(response: Response): Response {
  for (const [name, value] of Object.entries(STUDENT_QR_NO_STORE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

const CONFIG_WARNING_INTERVAL_MS = 10 * 60_000;
let lastConfigWarning = -Infinity;
let lastOriginWarning = -Infinity;

/**
 * Error response for the QR routes: AppErrors (401, 404, 429, 503 ...) with
 * their status, code and safe details; anything else through the shared
 * handler (500, sanitized error log). Always no-store; 429 adds Retry-After.
 * A missing / invalid STUDENT_QR_SECRET is reported to operators at most
 * every 10 minutes, naming the problem, never the value.
 */
export function studentQrErrorResponse(error: unknown, request: Request): Response {
  if (error instanceof StudentQrServiceError && error.code === "STUDENT_QR_NOT_CONFIGURED") {
    const now = Date.now();
    if (now - lastConfigWarning >= CONFIG_WARNING_INTERVAL_MS) {
      lastConfigWarning = now;
      console.warn(`[student-qr] QR codes are unavailable: ${error.internalReason ?? "STUDENT_QR_SECRET is not configured."}`);
    }
  }

  const response = withNoStore(handleRouteError(error, { request }));
  if (error instanceof StudentQrServiceError && error.code === "QR_REGENERATION_LIMIT") {
    const seconds = (error.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
      response.headers.set("Retry-After", String(Math.ceil(seconds)));
    }
  }
  return response;
}

/** 403 for a refused same-origin check (no request details echoed). */
export function crossOriginRejectedResponse(decision: Exclude<SameOriginDecision, { allowed: true }>): Response {
  if (decision.reason === "origin-not-configured") {
    const now = Date.now();
    if (now - lastOriginWarning >= CONFIG_WARNING_INTERVAL_MS) {
      lastOriginWarning = now;
      console.warn(
        "[student-qr] QR regeneration refused: set APP_URL or NEXT_PUBLIC_APP_URL to the application's public origin."
      );
    }
  }
  return withNoStore(
    apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED")
  );
}
