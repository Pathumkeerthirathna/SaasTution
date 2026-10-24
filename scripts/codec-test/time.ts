/*
 * Codec test: how a token's expiry is shown. Display only: token creation,
 * lifetime and verification are not affected.
 *
 * The UTC time (ISO, "Z") is shown together with the local time in a named
 * IANA time zone (default Asia/Colombo), formatted by Intl with that zone's
 * own rules (no hard-coded offset), and the minutes remaining.
 */

export const DISPLAY_TIME_ZONE = "Asia/Colombo";

/** "2026-10-21 01:48" in the given time zone, or null if Intl cannot use it. */
export function formatLocalTime(instant: Date, timeZone: string = DISPLAY_TIME_ZONE): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";

    return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
  } catch {
    return null;
  }
}

/** Whole minutes from `now` until `expiresAt` (negative once expired). */
export function minutesRemaining(expiresAt: Date, now: Date): number {
  return Math.floor((expiresAt.getTime() - now.getTime()) / 60_000);
}

/**
 * "2026-10-20T20:18:56Z (2026-10-21 01:48 Asia/Colombo, in 60 min)", or
 * "... , EXPIRED" once it has passed.
 */
export function formatExpiry(expiresAt: Date, now: Date = new Date(), timeZone: string = DISPLAY_TIME_ZONE): string {
  const utc = expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z");
  const local = formatLocalTime(expiresAt, timeZone);
  const remaining = minutesRemaining(expiresAt, now);
  const when = expiresAt.getTime() <= now.getTime() ? "EXPIRED" : `in ${remaining} min`;

  return `${utc} (${local === null ? `local time unavailable for ${timeZone}` : `${local} ${timeZone}`}, ${when})`;
}
