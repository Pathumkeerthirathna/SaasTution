// Sri Lanka Standard Time is UTC+05:30 all year round (no daylight saving).
const SRI_LANKA_UTC_OFFSET_MINUTES = 5 * 60 + 30;
const SRI_LANKA_OFFSET_MS = SRI_LANKA_UTC_OFFSET_MINUTES * 60 * 1000;

/**
 * Returns a `Date` whose UTC calendar fields equal the current Sri Lankan
 * wall-clock time.
 *
 * The database timestamp columns are `timestamp without time zone`, so whatever
 * calendar fields the `Date` carries are the digits that get stored. Shifting by
 * the Sri Lanka offset before persisting means the stored value reads as local
 * Sri Lankan time instead of UTC.
 */
export function nowInSriLanka(): Date {
  return new Date(Date.now() + SRI_LANKA_OFFSET_MS);
}

/**
 * Shift an existing instant to Sri Lankan wall-clock time, for the same reason
 * as {@link nowInSriLanka}.
 */
export function toSriLankaWallClock(date: Date): Date {
  return new Date(date.getTime() + SRI_LANKA_OFFSET_MS);
}

/**
 * Format a value that was persisted with {@link nowInSriLanka} (i.e. its
 * calendar fields already hold Sri Lankan wall-clock time). The value must be
 * read back with `timeZone: "UTC"` so the stored digits are shown verbatim
 * rather than being converted again by the viewer's browser.
 */
export function formatStoredSriLankaDateTime(
  value: string | Date | null | undefined
): string {
  if (!value) return "—";

  return new Date(value).toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatStoredSriLankaDate(
  value: string | Date | null | undefined
): string {
  if (!value) return "—";

  return new Date(value).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
