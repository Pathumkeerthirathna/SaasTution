// Feature flag for Breakout Room Activities.
//
// BREAKOUT_ACTIVITIES_ENABLED gates the breakout activity APIs only: when it
// is off (unset, empty or anything but "true" / "1"), every breakout route
// answers 404 as if it did not exist, and no new breakout data can be created.
//
// It must NEVER gate the session safety checks. Ending or replacing a
// session always looks for existing breakout data, requires the export
// confirmation (expectedSummaryVersion) when there is any, and cleans it up,
// whatever this flag says: data created while the flag was on must not be
// silently deleted, or left behind, after it is turned off. The guard test
// tests/breakout-activities/flag-guard.test.cjs fails if the session code or
// the breakout session-data service imports this module.

import { AppError } from "@/lib/error-handler";

export const BREAKOUT_ACTIVITIES_FLAG = "BREAKOUT_ACTIVITIES_ENABLED";

const ENABLED_VALUES = new Set(["true", "1"]);

type Env = Record<string, string | undefined>;

/** True only when the flag is explicitly "true" or "1" (case-insensitive, trimmed). */
export function isBreakoutActivitiesEnabled(env: Env = process.env): boolean {
  const value = env[BREAKOUT_ACTIVITIES_FLAG];
  return typeof value === "string" && ENABLED_VALUES.has(value.trim().toLowerCase());
}

/**
 * First call in every breakout activity route. While the feature is off the
 * route does not exist for anyone: 404, never a hint that it is disabled.
 */
export function assertBreakoutActivitiesEnabled(env: Env = process.env): void {
  if (!isBreakoutActivitiesEnabled(env)) {
    throw new AppError("Not found.", 404, "NOT_FOUND");
  }
}
