/**
 * Historical approval of a student during a time window, from the
 * StudentConfirmationHistory rows (docs/student-confirmation-history.md).
 *
 * Pure: no database, no clock, no environment access. Applies to every
 * registration source. (The automatic joining fee waiver keeps its own,
 * public-registration-only rule in lib/fee-waiver.ts.)
 *
 * The timeline is rebuilt from the history chain only. registeredAt /
 * createdAt are NEVER used: they come from database defaults whose timezone
 * interpretation cannot be trusted, and existing rows got the time the column
 * was added.
 *
 * Every call needs an ApprovalHistoryContext: the instant approval
 * enforcement started in this environment (APPROVAL_FEATURE_STARTED_AT).
 * Students who existed before the approval feature were given PENDING by the
 * migration that introduced it, so "PENDING, never decided" only means
 * something from that instant on; earlier times are UNKNOWN unless a genuine
 * recorded decision proves an earlier point.
 */

export type ConfirmationStatus = "PENDING" | "APPROVED" | "REJECTED";

export type ApprovalDuringResult = "APPROVED" | "NOT_APPROVED" | "UNKNOWN";

/** Why part of the timeline is UNKNOWN. */
export type UnknownPeriodReason =
  /** Before approval enforcement started, with no recorded decision earlier. */
  | "BEFORE_APPROVAL_FEATURE"
  /** Before the first decision we know of (decisions made before history was recorded). */
  | "BEFORE_RECORDED_DECISIONS"
  /** A known PENDING / REJECTED period that Student.approvedAt contradicts. */
  | "APPROVED_AT_CONFLICT";

export type ApprovalDuringReason =
  | "KNOWN_APPROVED"
  | "APPROVED_AT_EVIDENCE"
  | "KNOWN_NOT_APPROVED"
  | UnknownPeriodReason
  | "BROKEN_HISTORY";

export type ApprovalDuringExplanation = {
  result: ApprovalDuringResult;
  reason: ApprovalDuringReason;
};

export type ApprovalStudent = {
  confirmationStatus: ConfirmationStatus;
  /** Time of the latest decision (Student.confirmedAt); null = never decided. */
  confirmedAt: Date | null;
  /** An approval instant (Student.approvedAt: the first approval, or the backfilled one). */
  approvedAt: Date | null;
};

export type ApprovalHistoryEntry = {
  id: string;
  fromStatus: ConfirmationStatus;
  toStatus: ConfirmationStatus;
  decidedAt: Date;
  previousConfirmedAt: Date | null;
};

/** Half-open UTC interval [start, end). */
export type ApprovalWindow = { start: Date; end: Date };

export type ApprovalHistoryContext = {
  /**
   * When approval enforcement started in this environment (real UTC instant).
   * Must not be earlier than the real go-live; a later value is safe (it only
   * produces more UNKNOWN).
   */
  approvalFeatureStartedAt: Date;
};

/** A period of the timeline; null bounds are open (-infinity / +infinity). */
export type ConfirmationSegment = {
  from: Date | null;
  to: Date | null;
  status: ConfirmationStatus | "UNKNOWN";
  /** Set exactly when status is UNKNOWN. */
  reason?: UnknownPeriodReason;
};

/** Name of the per-environment setting that supplies approvalFeatureStartedAt. */
export const APPROVAL_FEATURE_STARTED_AT_SETTING = "APPROVAL_FEATURE_STARTED_AT";

const time = (value: Date) => value.getTime();

const isValidDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());

const sameInstant = (a: Date | null, b: Date | null) =>
  a === null || b === null ? a === b : time(a) === time(b);

/** Fail closed: never evaluate history without a valid feature-start instant. */
function assertValidContext(context: ApprovalHistoryContext) {
  if (!context || !isValidDate(context.approvalFeatureStartedAt)) {
    throw new TypeError(
      "Approval history needs a valid approvalFeatureStartedAt (" + APPROVAL_FEATURE_STARTED_AT_SETTING + ")."
    );
  }
}

/**
 * The largest valid JavaScript Date (+275760-09-13T00:00:00.000Z), in
 * milliseconds. approvalAt cannot evaluate it: its one-millisecond window
 * would end on an invalid Date.
 */
export const MAX_JS_DATE_MS = 8.64e15;

/** Largest accepted UTC offset, either side: 14:00. */
const MAX_OFFSET_MINUTES = 14 * 60;

// ISO 8601 with an explicit offset: YYYY-MM-DDTHH:MM[:SS[.mmm]](Z|±HH:MM).
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

/**
 * Parses the APPROVAL_FEATURE_STARTED_AT setting into a context. The caller
 * passes the raw setting (e.g. process.env value); there is no default and no
 * fallback: a missing, malformed or impossible value throws. The value itself
 * is never included in the error message.
 *
 * Accepted: an ISO 8601 instant with an explicit "Z" or "±HH:MM" offset, e.g.
 * "2026-07-28T10:00:00+05:30". A timezone-less value is refused (it would
 * depend on the server's timezone), and so is an impossible calendar date
 * (no rolling 30 February over into March).
 */
export function approvalHistoryContextFromSetting(raw: string | undefined | null): ApprovalHistoryContext {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`${APPROVAL_FEATURE_STARTED_AT_SETTING} is not configured.`);
  }

  const match = ISO_INSTANT.exec(raw.trim());
  const invalid = () =>
    new Error(
      `${APPROVAL_FEATURE_STARTED_AT_SETTING} must be an ISO 8601 instant with an explicit offset: YYYY-MM-DDTHH:MM[:SS[.mmm]] followed by Z or ±HH:MM (between -14:00 and +14:00; not -00:00).`
    );

  if (!match) throw invalid();

  const [, y, mo, d, h, mi, s = "0", ms = "0", zulu, sign, oh = "0", om = "0"] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const millisecond = Number(ms.padEnd(3, "0"));
  const offsetHours = Number(oh);
  const offsetMinutes = Number(om);
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;

  // Offsets: -14:00 to +14:00 inclusive (the real-world extremes are -12:00
  // and +14:00). "-00:00" means "offset unknown" (RFC 3339), so it is not a
  // definite instant; "Z" and "+00:00" are UTC.
  const offsetTotalMinutes = offsetHours * 60 + offsetMinutes;
  const invalidOffset =
    !zulu && (offsetMinutes > 59 || offsetTotalMinutes > MAX_OFFSET_MINUTES || (sign === "-" && offsetTotalMinutes === 0));

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    invalidOffset
  ) {
    throw invalid();
  }

  const offset = zulu ? 0 : (sign === "-" ? -1 : 1) * offsetTotalMinutes * 60_000;
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offset);

  if (!isValidDate(instant)) throw invalid();

  return { approvalFeatureStartedAt: instant };
}

/** Deterministic history order: decidedAt, then id. */
export function sortConfirmationHistory<T extends ApprovalHistoryEntry>(history: readonly T[]): T[] {
  return [...history].sort((a, b) => {
    const diff = time(a.decidedAt) - time(b.decidedAt);
    return diff !== 0 ? diff : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

const contains = (segment: ConfirmationSegment, instant: Date) =>
  (segment.from === null || time(segment.from) <= time(instant)) &&
  (segment.to === null || time(instant) < time(segment.to));

/**
 * The student's confirmation timeline, or null when the history chain is
 * broken or impossible (the caller then knows nothing: UNKNOWN).
 *
 * Chain rules, in (decidedAt, id) order (unchanged):
 *  - every row's fromStatus is the previous row's toStatus;
 *  - every row's previousConfirmedAt is the previous row's decidedAt;
 *  - decisions are strictly ordered (previousConfirmedAt < decidedAt);
 *  - the last row matches the student's current status and confirmedAt.
 * The starting point is the first row's fromStatus / previousConfirmedAt (or,
 * with no history, the current status / confirmedAt). PENDING with a
 * timestamp, or REJECTED without one, cannot happen: null.
 *
 * Known from (H1):
 *  - the starting timestamp, when there is one (a real decision);
 *  - otherwise approvalFeatureStartedAt, or the first recorded decision if
 *    that is earlier (a genuine decision proves the feature existed then).
 * Everything before is UNKNOWN (BEFORE_RECORDED_DECISIONS /
 * BEFORE_APPROVAL_FEATURE).
 *
 * approvedAt (M1): if it falls in a known PENDING or REJECTED period, that
 * period becomes UNKNOWN (APPROVED_AT_CONFLICT). An invalid approvedAt makes
 * the whole history unusable (null).
 */
export function confirmationTimeline(
  student: ApprovalStudent,
  history: readonly ApprovalHistoryEntry[],
  context: ApprovalHistoryContext
): ConfirmationSegment[] | null {
  assertValidContext(context);

  if (student.approvedAt !== null && !isValidDate(student.approvedAt)) return null;

  const rows = sortConfirmationHistory(history);

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];

    if (row.fromStatus === row.toStatus) return null;
    if (row.previousConfirmedAt && time(row.previousConfirmedAt) >= time(row.decidedAt)) return null;

    if (i > 0) {
      const previous = rows[i - 1];
      if (row.fromStatus !== previous.toStatus) return null;
      if (!sameInstant(row.previousConfirmedAt, previous.decidedAt)) return null;
    }
  }

  const last = rows[rows.length - 1];

  if (last && (last.toStatus !== student.confirmationStatus || !sameInstant(last.decidedAt, student.confirmedAt))) {
    return null;
  }

  const startStatus = rows.length > 0 ? rows[0].fromStatus : student.confirmationStatus;
  const startAt = rows.length > 0 ? rows[0].previousConfirmedAt : student.confirmedAt;

  if (startStatus === "PENDING" && startAt !== null) return null;
  if (startStatus === "REJECTED" && startAt === null) return null;

  const featureStart = context.approvalFeatureStartedAt;
  const firstDecision = rows[0]?.decidedAt ?? null;
  const knownFrom =
    startAt !== null
      ? startAt
      : firstDecision !== null && time(firstDecision) < time(featureStart)
        ? firstDecision
        : featureStart;

  const segments: ConfirmationSegment[] = [
    {
      from: null,
      to: knownFrom,
      status: "UNKNOWN",
      reason: startAt !== null ? "BEFORE_RECORDED_DECISIONS" : "BEFORE_APPROVAL_FEATURE",
    },
  ];

  // The starting status, from knownFrom to the first recorded decision (empty
  // when a decision earlier than the feature start is the first known point).
  if (firstDecision === null || time(knownFrom) < time(firstDecision)) {
    segments.push({ from: knownFrom, to: firstDecision, status: startStatus });
  }

  rows.forEach((row, i) => {
    segments.push({ from: row.decidedAt, to: rows[i + 1]?.decidedAt ?? null, status: row.toStatus });
  });

  if (student.approvedAt !== null) {
    const approvedAt = student.approvedAt;
    const index = segments.findIndex((segment) => contains(segment, approvedAt));
    const holding = segments[index];

    if (holding && (holding.status === "PENDING" || holding.status === "REJECTED")) {
      segments[index] = { from: holding.from, to: holding.to, status: "UNKNOWN", reason: "APPROVED_AT_CONFLICT" };
    }
  }

  return segments;
}

function overlaps(segment: ConfirmationSegment, window: ApprovalWindow) {
  const startsBeforeEnd = segment.from === null || time(segment.from) < time(window.end);
  const endsAfterStart = segment.to === null || time(segment.to) > time(window.start);
  return startsBeforeEnd && endsAfterStart;
}

function assertValidWindow(window: ApprovalWindow) {
  const start = window?.start;
  const end = window?.end;

  if (!isValidDate(start) || !isValidDate(end)) {
    throw new RangeError("approvalDuring: the window needs valid start and end dates.");
  }

  if (time(start) >= time(end)) {
    throw new RangeError("approvalDuring: the window start must be before its end.");
  }
}

const UNKNOWN_REASON_PRIORITY: UnknownPeriodReason[] = [
  "APPROVED_AT_CONFLICT",
  "BEFORE_RECORDED_DECISIONS",
  "BEFORE_APPROVAL_FEATURE",
];

/**
 * approvalDuring with the reason, for review screens:
 *  - KNOWN_APPROVED: an approved period overlaps the window;
 *  - APPROVED_AT_EVIDENCE: approvedAt falls in the window, inside an unknown
 *    (not conflicting) period;
 *  - BROKEN_HISTORY: the chain is broken or impossible (UNKNOWN);
 *  - APPROVED_AT_CONFLICT / BEFORE_RECORDED_DECISIONS /
 *    BEFORE_APPROVAL_FEATURE: part of the window is unknown (UNKNOWN);
 *  - KNOWN_NOT_APPROVED: the whole window is known and never approved.
 */
export function explainApprovalDuring(
  student: ApprovalStudent,
  history: readonly ApprovalHistoryEntry[],
  window: ApprovalWindow,
  context: ApprovalHistoryContext
): ApprovalDuringExplanation {
  assertValidContext(context);
  assertValidWindow(window);

  const segments = confirmationTimeline(student, history, context);

  if (segments === null) return { result: "UNKNOWN", reason: "BROKEN_HISTORY" };

  const relevant = segments.filter((segment) => overlaps(segment, window));

  if (relevant.some((segment) => segment.status === "APPROVED")) {
    return { result: "APPROVED", reason: "KNOWN_APPROVED" };
  }

  const approvedAt = student.approvedAt;

  if (approvedAt && time(approvedAt) >= time(window.start) && time(approvedAt) < time(window.end)) {
    const holding = segments.find((segment) => contains(segment, approvedAt));

    // Evidence only inside a genuinely unknown period, never a conflicting one.
    if (holding && holding.status === "UNKNOWN" && holding.reason !== "APPROVED_AT_CONFLICT") {
      return { result: "APPROVED", reason: "APPROVED_AT_EVIDENCE" };
    }
  }

  const unknownReasons = new Set(
    relevant.filter((segment) => segment.status === "UNKNOWN").map((segment) => segment.reason)
  );
  const unknownReason = UNKNOWN_REASON_PRIORITY.find((reason) => unknownReasons.has(reason));

  if (unknownReason) return { result: "UNKNOWN", reason: unknownReason };

  return { result: "NOT_APPROVED", reason: "KNOWN_NOT_APPROVED" };
}

/**
 * Was the student approved at ANY moment of [window.start, window.end)?
 * APPROVED, NOT_APPROVED, or UNKNOWN (see explainApprovalDuring for why).
 * For historical information and reporting; automatic attendance decisions
 * use approvalAt (a point in time) instead.
 * `history` must be ALL of this student's StudentConfirmationHistory rows.
 * Throws when the context or the window is missing or invalid.
 */
export function approvalDuring(
  student: ApprovalStudent,
  history: readonly ApprovalHistoryEntry[],
  window: ApprovalWindow,
  context: ApprovalHistoryContext
): ApprovalDuringResult {
  return explainApprovalDuring(student, history, window, context).result;
}

/**
 * Approval at ONE instant (point in time), with the reason: the same timeline
 * as explainApprovalDuring (H1 known-from point, M1 approvedAt conflicts,
 * chain checks), evaluated at `instant`.
 *
 * Periods are half-open [from, to): a decision recorded exactly at `instant`
 * already applies at that instant, and the period it ends does not. Instants
 * have millisecond precision, so this is exactly the one-millisecond window
 * [instant, instant + 1 ms).
 *
 * For automatic decisions (docs/student-confirmation-history.md): approval at
 * the lecture's scheduled start (roster, automatic ABSENT), at the
 * server-recorded scan / join time (QR scans, online joins, backfill).
 * Throws when the context or the instant is missing or invalid, and for the
 * largest valid JavaScript Date (MAX_JS_DATE_MS), which has no following
 * millisecond to end its window.
 */
export function explainApprovalAt(
  student: ApprovalStudent,
  history: readonly ApprovalHistoryEntry[],
  instant: Date,
  context: ApprovalHistoryContext
): ApprovalDuringExplanation {
  assertValidContext(context);

  if (!isValidDate(instant)) {
    throw new RangeError("approvalAt: a valid instant is required.");
  }

  if (time(instant) >= MAX_JS_DATE_MS) {
    throw new RangeError("approvalAt: the instant is outside the supported range.");
  }

  return explainApprovalDuring(student, history, { start: instant, end: new Date(time(instant) + 1) }, context);
}

/** APPROVED, NOT_APPROVED or UNKNOWN at one instant (see explainApprovalAt). */
export function approvalAt(
  student: ApprovalStudent,
  history: readonly ApprovalHistoryEntry[],
  instant: Date,
  context: ApprovalHistoryContext
): ApprovalDuringResult {
  return explainApprovalAt(student, history, instant, context).result;
}

/**
 * Only a known approval makes a student eligible for anything automatic
 * (automatic absence at finalization, automatic QR attendance). UNKNOWN and
 * NOT_APPROVED never are.
 */
export function isAutomaticallyEligible(result: ApprovalDuringResult): boolean {
  return result === "APPROVED";
}

/** UNKNOWN is left to the teacher: listed for manual review, never decided automatically. */
export function needsManualApprovalReview(result: ApprovalDuringResult): boolean {
  return result === "UNKNOWN";
}
