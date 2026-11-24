import { AppError } from "@/lib/error-handler";
import { feePaymentState, PAYMENT_STATE_SELECT, type FeePaymentRecord, type FeePaymentStateName } from "@/lib/fee-payment-state";
import { publicRegistrationEnrolmentId } from "@/lib/fee-waiver";
import { prisma } from "@/lib/prisma";
import { nowInSriLanka, sriLankaCalendarParts } from "@/lib/time";
import { graceEndsAt } from "@/services/class-access-service";

/*
 * Monthly payment-based RESOURCE access ("Restrict access to resources for
 * unpaid months", Class.restrictUnpaidStudentAccess + paymentGracePeriodDays).
 *
 * Resources: uploaded recordings, lecture notes, class papers, material
 * bundle files, saved whiteboards and YouTube recording links. Each belongs
 * to ONE Sri Lankan billing month (billingMonthOf*: the original upload
 * instant in Asia/Colombo; notes uploaded before Note.uploadedAt existed use
 * their lecture's date; a material bundle uses the year / month the teacher
 * chose for it). Editing a resource never changes its month.
 *
 * Decision for one student, class and month (decideResourceMonth), in order:
 *   1. not actively enrolled                 -> null (the routes answer 404);
 *   2. teacher override GRANTED / REVOKED    -> unlocked / locked;
 *   3. class setting off                     -> unlocked;
 *   4. the month's fee (any enrolment of the class, the active one first):
 *        nothing outstanding (paid by CONFIRMED, not reversed money, Free
 *        Card, waived or adjusted to 0)        -> unlocked;
 *        initial payment of a public
 *        registration (approval month or
 *        earlier, original enrolment)           -> locked at once, no grace;
 *        no due date                            -> unlocked (existing rule);
 *        due date + grace not yet passed        -> unlocked (grace);
 *        otherwise                              -> locked. A slip awaiting
 *        the teacher (PENDING / NEEDS_CLARIFICATION) does NOT unlock.
 *   5. no fee: before the first enrolment month -> locked (pre-enrolment);
 *        otherwise                              -> unlocked (no charge
 *        recorded: the existing "no fee record, no restriction" rule).
 *
 * Evaluated on every request from the database (no stored flag, no JWT
 * claim, no cross-request cache): confirming or reversing a payment, a
 * waiver, a Free Card, the class setting, an override or an enrolment change
 * applies on the next request. One resolver per request loads everything it
 * needs in three batched queries and memoises each (class, month) decision,
 * so listing N resources never runs N payment queries.
 *
 * Quizzes, assignments, attendance and the live classroom are NOT resources:
 * they keep the class-level overdue rule of services/class-access-service.ts
 * unchanged.
 */

export const RESOURCE_MONTH_LOCKED = "RESOURCE_MONTH_LOCKED";

export type ResourceMonth = { year: number; month: number };

export type ResourceAccessOverrideState = "GRANTED" | "REVOKED";

export type ResourceAccessSource =
  | "OVERRIDE_GRANTED"
  | "OVERRIDE_REVOKED"
  | "SETTING_OFF"
  | "PAID"
  | "NO_FEE"
  | "NO_DUE_DATE"
  | "GRACE"
  | "UNPAID"
  | "INITIAL_PAYMENT"
  | "PRE_ENROLMENT";

export type ResourceMonthFee = {
  feeId: string;
  paymentStatus: FeePaymentStateName;
  finalAmount: number;
  /** Received: CONFIRMED, not reversed. */
  confirmedTotal: number;
  /** Still payable (0 with a Free Card). */
  outstanding: number;
  /** Slips awaiting processing (PENDING + NEEDS_CLARIFICATION); never unlock. */
  awaitingTotal: number;
  /** Sri Lankan wall-clock digits (as stored), ISO. */
  dueDate: string | null;
  /** Last moment of the grace period (same convention), ISO. */
  graceEndsAt: string | null;
  /** The grace period has not ended yet (only meaningful while something is outstanding). */
  graceActive: boolean;
  /** The first payment of a public registration (no grace period applies). */
  initialPayment: boolean;
};

export type ResourceMonthDecision = {
  classId: string;
  className: string;
  classStudentId: string;
  year: number;
  month: number;
  accessible: boolean;
  source: ResourceAccessSource;
  override: ResourceAccessOverrideState | null;
  restrictionEnabled: boolean;
  gracePeriodDays: number;
  fee: ResourceMonthFee | null;
};

// ---- Billing months ------------------------------------------------------------------

/** The Sri Lankan (Asia/Colombo) calendar month of a real instant. */
export function billingMonthOf(instant: Date): ResourceMonth {
  const { year, month } = sriLankaCalendarParts(instant);
  return { year, month };
}

/** A note's month: its upload instant, or its lecture's date for notes uploaded before uploadedAt existed. */
export function noteBillingMonth(note: { uploadedAt: Date | null; lecture: { date: Date } }): ResourceMonth {
  return billingMonthOf(note.uploadedAt ?? note.lecture.date);
}

export const monthKey = (m: ResourceMonth) => `${m.year}-${String(m.month).padStart(2, "0")}`;
const monthIndex = (m: ResourceMonth) => m.year * 12 + (m.month - 1);

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function formatBillingMonth(m: ResourceMonth): string {
  return `${MONTH_NAMES[m.month - 1] ?? m.month} ${m.year}`;
}

// ---- The pure rule -----------------------------------------------------------------------

export type ResourceMonthInput = {
  classId: string;
  className: string;
  classStudentId: string;
  restrictionEnabled: boolean;
  gracePeriodDays: number;
  month: ResourceMonth;
  firstEnrolmentMonth: ResourceMonth;
  override: ResourceAccessOverrideState | null;
  fee: {
    id: string;
    finalAmount: number;
    freeCard: boolean;
    dueDate: Date | null;
    payments: readonly FeePaymentRecord[];
    initialPayment: boolean;
  } | null;
  /** nowInSriLanka(): Sri Lankan wall-clock digits, like the stored due dates. */
  nowSriLanka: Date;
};

export function decideResourceMonth(input: ResourceMonthInput): ResourceMonthDecision {
  let fee: ResourceMonthFee | null = null;
  if (input.fee) {
    const state = feePaymentState(input.fee, input.fee.payments);
    const ends = input.fee.dueDate ? graceEndsAt(input.fee.dueDate, input.gracePeriodDays) : null;
    fee = {
      feeId: input.fee.id,
      paymentStatus: state.state,
      finalAmount: input.fee.finalAmount,
      confirmedTotal: state.confirmedTotal,
      outstanding: state.outstanding,
      awaitingTotal: state.pendingTotal + state.clarificationTotal,
      dueDate: input.fee.dueDate ? input.fee.dueDate.toISOString() : null,
      graceEndsAt: ends ? ends.toISOString() : null,
      graceActive: ends !== null && !input.fee.initialPayment && input.nowSriLanka.getTime() <= ends.getTime(),
      initialPayment: input.fee.initialPayment,
    };
  }

  const result = (accessible: boolean, source: ResourceAccessSource): ResourceMonthDecision => ({
    classId: input.classId,
    className: input.className,
    classStudentId: input.classStudentId,
    year: input.month.year,
    month: input.month.month,
    accessible,
    source,
    override: input.override,
    restrictionEnabled: input.restrictionEnabled,
    gracePeriodDays: input.gracePeriodDays,
    fee,
  });

  if (input.override === "GRANTED") return result(true, "OVERRIDE_GRANTED");
  if (input.override === "REVOKED") return result(false, "OVERRIDE_REVOKED");
  if (!input.restrictionEnabled) return result(true, "SETTING_OFF");

  if (fee) {
    if (fee.outstanding <= 0) return result(true, "PAID");
    if (fee.initialPayment) return result(false, "INITIAL_PAYMENT");
    if (!fee.dueDate) return result(true, "NO_DUE_DATE");
    if (fee.graceActive) return result(true, "GRACE");
    return result(false, "UNPAID");
  }
  if (monthIndex(input.month) < monthIndex(input.firstEnrolmentMonth)) return result(false, "PRE_ENROLMENT");
  return result(true, "NO_FEE");
}

// ---- Per-request resolver ----------------------------------------------------------------

export type ResourceAccessNoticeItem = {
  classId: string;
  className: string;
  year: number;
  month: number;
  locked: boolean;
  source: ResourceAccessSource;
  paymentStatus: FeePaymentStateName | null;
  outstandingAmount: number;
  dueDate: string | null;
  graceEndsAt: string | null;
  graceActive: boolean;
  gracePeriodDays: number;
};

export type StudentResourceAccess = {
  readonly studentId: string;
  /** null when the student is not actively enrolled in the class (the caller answers 404). */
  decide(classId: string, month: ResourceMonth): ResourceMonthDecision | null;
  /**
   * Months the student should hear about: every locked month that has a fee
   * or a REVOKED override, and unpaid months past their due date but still
   * inside the grace period. Paid, waived and Free Card months never appear.
   */
  noticeItems(): ResourceAccessNoticeItem[];
};

type LoadOptions = {
  /** Only these classes (an empty list loads nothing). */
  classIds?: readonly string[];
  /** Only these months' fees and overrides (delivery of one resource). */
  months?: readonly ResourceMonth[];
};

type EnrolmentRow = {
  id: string;
  classId: string;
  isActive: boolean;
  assignedAt: Date;
  class: { id: string; name: string; restrictUnpaidStudentAccess: boolean; paymentGracePeriodDays: number };
  student: { registrationSource: string; publicClassId: string | null; confirmationStatus: string; approvedAt: Date | null };
};

type FeeRow = {
  id: string;
  classStudentId: string;
  year: number;
  month: number;
  finalAmount: number;
  freeCard: boolean;
  dueDate: Date | null;
  payments: FeePaymentRecord[];
};

/**
 * Loads the student's resource access in three batched queries (enrolments
 * with their class settings, fees with their payments, overrides) and
 * returns a resolver that decides each (class, month) once, in memory.
 */
export async function loadStudentResourceAccess(studentId: string, options: LoadOptions = {}): Promise<StudentResourceAccess> {
  const classIds = options.classIds ? [...new Set(options.classIds)] : undefined;
  if (!studentId || (classIds && classIds.length === 0)) return emptyResolver(studentId);

  const classFilter = classIds ? { classId: { in: classIds } } : {};
  const monthFilter =
    options.months && options.months.length > 0
      ? { OR: dedupeMonths(options.months).map((m) => ({ year: m.year, month: m.month })) }
      : {};

  const [enrolments, fees, overrides] = await Promise.all([
    prisma.classStudent.findMany({
      where: { studentId, class: { status: 0 }, ...classFilter },
      select: {
        id: true,
        classId: true,
        isActive: true,
        assignedAt: true,
        class: { select: { id: true, name: true, restrictUnpaidStudentAccess: true, paymentGracePeriodDays: true } },
        student: { select: { registrationSource: true, publicClassId: true, confirmationStatus: true, approvedAt: true } },
      },
    }) as Promise<EnrolmentRow[]>,
    prisma.classStudentFee.findMany({
      where: { classStudent: { studentId, class: { status: 0 }, ...classFilter }, ...monthFilter },
      select: {
        id: true,
        classStudentId: true,
        year: true,
        month: true,
        finalAmount: true,
        freeCard: true,
        dueDate: true,
        payments: { select: PAYMENT_STATE_SELECT },
      },
    }) as Promise<FeeRow[]>,
    prisma.classStudentResourceAccess.findMany({
      where: { classStudent: { studentId, isActive: true, class: { status: 0 }, ...classFilter }, ...monthFilter },
      select: { classStudentId: true, year: true, month: true, access: true },
    }),
  ]);

  return buildResolver(studentId, enrolments, fees, overrides, nowInSriLanka());
}

function dedupeMonths(months: readonly ResourceMonth[]): ResourceMonth[] {
  const seen = new Map<string, ResourceMonth>();
  for (const m of months) {
    if (Number.isInteger(m.year) && Number.isInteger(m.month) && m.month >= 1 && m.month <= 12) seen.set(monthKey(m), m);
  }
  return [...seen.values()];
}

function emptyResolver(studentId: string): StudentResourceAccess {
  return { studentId, decide: () => null, noticeItems: () => [] };
}

function buildResolver(
  studentId: string,
  enrolments: EnrolmentRow[],
  fees: FeeRow[],
  overrides: { classStudentId: string; year: number; month: number; access: ResourceAccessOverrideState }[],
  nowSriLanka: Date
): StudentResourceAccess {
  const byClass = new Map<string, EnrolmentRow[]>();
  for (const e of enrolments) byClass.set(e.classId, [...(byClass.get(e.classId) ?? []), e]);
  const enrolmentById = new Map(enrolments.map((e) => [e.id, e]));

  // Initial payment (public registration): the original enrolment's fees up
  // to the month of the student's first approval (as in class-access-service).
  const student = enrolments[0]?.student;
  let initial: { enrolmentId: string; month: ResourceMonth } | null = null;
  if (student && student.registrationSource === "PUBLIC_CLASS" && student.publicClassId && student.confirmationStatus === "APPROVED" && student.approvedAt) {
    const enrolmentId = publicRegistrationEnrolmentId(student, byClass.get(student.publicClassId) ?? []);
    if (enrolmentId) initial = { enrolmentId, month: billingMonthOf(student.approvedAt) };
  }

  // Fees per class and month: the active enrolment's row first, else the latest enrolment's.
  const feeByClassMonth = new Map<string, FeeRow>();
  const feeRank = (fee: FeeRow) => {
    const e = enrolmentById.get(fee.classStudentId);
    return e ? (e.isActive ? Number.MAX_SAFE_INTEGER : e.assignedAt.getTime()) : -1;
  };
  for (const fee of fees) {
    const e = enrolmentById.get(fee.classStudentId);
    if (!e) continue;
    const key = `${e.classId}|${monthKey(fee)}`;
    const current = feeByClassMonth.get(key);
    if (!current || feeRank(fee) > feeRank(current)) feeByClassMonth.set(key, fee);
  }

  const overrideByEnrolmentMonth = new Map(overrides.map((o) => [`${o.classStudentId}|${monthKey(o)}`, o.access]));
  const memo = new Map<string, ResourceMonthDecision | null>();

  function decide(classId: string, month: ResourceMonth): ResourceMonthDecision | null {
    const key = `${classId}|${monthKey(month)}`;
    if (memo.has(key)) return memo.get(key)!;
    const classEnrolments = byClass.get(classId) ?? [];
    const active = classEnrolments.find((e) => e.isActive);
    let decision: ResourceMonthDecision | null = null;
    if (active) {
      const first = classEnrolments.reduce((min, e) => {
        const m = billingMonthOf(e.assignedAt);
        return monthIndex(m) < monthIndex(min) ? m : min;
      }, billingMonthOf(active.assignedAt));
      const fee = feeByClassMonth.get(key) ?? null;
      decision = decideResourceMonth({
        classId,
        className: active.class.name,
        classStudentId: active.id,
        restrictionEnabled: active.class.restrictUnpaidStudentAccess,
        gracePeriodDays: active.class.paymentGracePeriodDays,
        month,
        firstEnrolmentMonth: first,
        override: overrideByEnrolmentMonth.get(`${active.id}|${monthKey(month)}`) ?? null,
        fee: fee
          ? {
              id: fee.id,
              finalAmount: fee.finalAmount,
              freeCard: fee.freeCard,
              dueDate: fee.dueDate,
              payments: fee.payments,
              initialPayment:
                initial !== null && fee.classStudentId === initial.enrolmentId && monthIndex(fee) <= monthIndex(initial.month),
            }
          : null,
        nowSriLanka,
      });
    }
    memo.set(key, decision);
    return decision;
  }

  function noticeItems(): ResourceAccessNoticeItem[] {
    const candidates = new Map<string, { classId: string; month: ResourceMonth }>();
    for (const [key, fee] of feeByClassMonth) candidates.set(key, { classId: key.split("|")[0], month: { year: fee.year, month: fee.month } });
    for (const o of overrides) {
      const e = enrolmentById.get(o.classStudentId);
      if (e && o.access === "REVOKED") candidates.set(`${e.classId}|${monthKey(o)}`, { classId: e.classId, month: { year: o.year, month: o.month } });
    }
    const items: ResourceAccessNoticeItem[] = [];
    for (const { classId, month } of candidates.values()) {
      const d = decide(classId, month);
      if (!d) continue;
      // Grace: only once the due date itself has passed (before it, nothing is late yet).
      const inGrace =
        d.source === "GRACE" &&
        (d.fee?.outstanding ?? 0) > 0 &&
        d.fee?.dueDate !== null &&
        d.fee?.dueDate !== undefined &&
        nowSriLanka.getTime() > new Date(d.fee.dueDate).getTime();
      if (d.accessible && !inGrace) continue;
      items.push({
        classId: d.classId,
        className: d.className,
        year: d.year,
        month: d.month,
        locked: !d.accessible,
        source: d.source,
        paymentStatus: d.fee?.paymentStatus ?? null,
        outstandingAmount: d.fee?.outstanding ?? 0,
        dueDate: d.fee?.dueDate ?? null,
        graceEndsAt: d.fee?.graceEndsAt ?? null,
        graceActive: d.fee?.graceActive ?? false,
        gracePeriodDays: d.gracePeriodDays,
      });
    }
    return items.sort(
      (a, b) => a.className.localeCompare(b.className) || a.classId.localeCompare(b.classId) || a.year - b.year || a.month - b.month
    );
  }

  return { studentId, decide, noticeItems };
}

/** For listings: whether a resource of `classId` from `month` is shown locked (never for a class the student is not in). */
export function resourceLockFor(
  access: StudentResourceAccess,
  classId: string,
  month: ResourceMonth
): { locked: boolean; year: number; month: number } {
  const decision = access.decide(classId, month);
  return { locked: decision !== null && !decision.accessible, year: month.year, month: month.month };
}

// ---- Enforcement for the delivery routes -------------------------------------------------

export type ResourceRef =
  | { recordingId: string }
  | { noteId: string }
  | { whiteboardId: string }
  | { paperId: string }
  | { bundleId: string };

/** The resource's class and billing month (null when it does not exist). */
export async function resourceClassMonth(ref: ResourceRef): Promise<{ classId: string; month: ResourceMonth } | null> {
  if ("recordingId" in ref) {
    const row = await prisma.recordedLecture.findUnique({ where: { id: ref.recordingId }, select: { classId: true, createdAt: true } });
    return row ? { classId: row.classId, month: billingMonthOf(row.createdAt) } : null;
  }
  if ("noteId" in ref) {
    const row = await prisma.note.findUnique({
      where: { id: ref.noteId },
      select: { uploadedAt: true, lecture: { select: { classId: true, date: true } } },
    });
    return row ? { classId: row.lecture.classId, month: noteBillingMonth(row) } : null;
  }
  if ("whiteboardId" in ref) {
    const row = await prisma.lectureWhiteboard.findUnique({
      where: { id: ref.whiteboardId },
      select: { createdAt: true, lecture: { select: { classId: true } } },
    });
    return row ? { classId: row.lecture.classId, month: billingMonthOf(row.createdAt) } : null;
  }
  if ("paperId" in ref) {
    const row = await prisma.classPaper.findUnique({ where: { id: ref.paperId }, select: { classId: true, createdAt: true } });
    return row ? { classId: row.classId, month: billingMonthOf(row.createdAt) } : null;
  }
  const row = await prisma.materialBundle.findUnique({ where: { id: ref.bundleId }, select: { classId: true, year: true, month: true } });
  return row ? { classId: row.classId, month: { year: row.year, month: row.month } } : null;
}

/** The 403 message of a locked month (also shown on the player page). */
export function lockedResourceMessage(d: ResourceMonthDecision): string {
  const what = `${d.className} resources from ${formatBillingMonth(d)}`;
  switch (d.source) {
    case "OVERRIDE_REVOKED":
      return `Your teacher has locked the ${what}.`;
    case "PRE_ENROLMENT":
      return `The ${what} are from before you joined the class. Ask your teacher if you need them.`;
    case "INITIAL_PAYMENT":
      return `The ${what} open once your first class fee payment for ${formatBillingMonth(d)} is confirmed by your teacher. Please pay and submit your payment slip from the Payments page.`;
    default:
      return `The ${what} are locked because that month's class fee${d.fee ? ` (Rs. ${d.fee.outstanding.toLocaleString()} outstanding)` : ""} is unpaid after its due date and grace period. Please pay from the Payments page; access opens once the payment is confirmed.`;
  }
}

export function lockedResourceError(d: ResourceMonthDecision): AppError {
  return new AppError(lockedResourceMessage(d), 403, RESOURCE_MONTH_LOCKED, {
    classId: d.classId,
    className: d.className,
    year: d.year,
    month: d.month,
    source: d.source,
  });
}

/**
 * The single check every resource delivery route makes after authenticating
 * the student: 403 RESOURCE_MONTH_LOCKED when the resource's billing month is
 * locked. Unknown resources and classes the student is not actively enrolled
 * in are left to the route's own 404 (nothing is revealed).
 */
export async function assertResourceAccessForStudent(
  studentId: string,
  ref: ResourceRef,
  access?: StudentResourceAccess
): Promise<void> {
  if (!studentId) return;
  const target = await resourceClassMonth(ref);
  if (!target) return;
  const resolver = access ?? (await loadStudentResourceAccess(studentId, { classIds: [target.classId], months: [target.month] }));
  const decision = resolver.decide(target.classId, target.month);
  if (decision && !decision.accessible) throw lockedResourceError(decision);
}

// ---- Teacher: one student's month (Payments page "Resource access") ----------------------

export type ResourceAccessChoice = "DEFAULT" | ResourceAccessOverrideState;

export type TeacherResourceAccessView = {
  student: { id: string; name: string; registrationNumber: string | null };
  class: { id: string; name: string };
  decision: ResourceMonthDecision;
};

export function parseResourceAccessMonth(year: unknown, month: unknown): ResourceMonth {
  const y = typeof year === "string" && /^\d{4}$/.test(year) ? Number(year) : year;
  const m = typeof month === "string" && /^\d{1,2}$/.test(month) ? Number(month) : month;
  if (typeof y !== "number" || !Number.isInteger(y) || y < 2000 || y > 2100) {
    throw new AppError("A valid year (2000 to 2100) is required.", 400, "VALIDATION_ERROR");
  }
  if (typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > 12) {
    throw new AppError("Month must be between 1 and 12.", 400, "VALIDATION_ERROR");
  }
  return { year: y, month: m };
}

export function parseResourceAccessChoice(value: unknown): ResourceAccessChoice {
  if (value === "DEFAULT" || value === "GRANTED" || value === "REVOKED") return value;
  throw new AppError("access must be DEFAULT, GRANTED or REVOKED.", 400, "VALIDATION_ERROR");
}

/** The teacher's own class and the student's ACTIVE enrolment in it (404 otherwise). */
async function ownedActiveEnrolment(teacherId: string, classId: string, studentId: string) {
  if (typeof studentId !== "string" || !studentId.trim()) {
    throw new AppError("studentId is required.", 400, "VALIDATION_ERROR");
  }
  const cls = await prisma.class.findFirst({ where: { id: classId, teacherId, status: 0 }, select: { id: true, name: true } });
  if (!cls) throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");
  const enrolment = await prisma.classStudent.findFirst({
    where: { classId, studentId, isActive: true, student: { status: 0 } },
    select: { id: true, student: { select: { id: true, name: true, registrationNumber: true } } },
  });
  if (!enrolment) throw new AppError("This student is not actively enrolled in this class.", 404, "STUDENT_NOT_ENROLLED");
  return { cls, enrolment };
}

async function teacherView(
  cls: { id: string; name: string },
  student: { id: string; name: string; registrationNumber: string | null },
  month: ResourceMonth
): Promise<TeacherResourceAccessView> {
  const access = await loadStudentResourceAccess(student.id, { classIds: [cls.id], months: [month] });
  const decision = access.decide(cls.id, month);
  if (!decision) throw new AppError("This student is not actively enrolled in this class.", 404, "STUDENT_NOT_ENROLLED");
  return { student, class: cls, decision };
}

export async function getResourceAccessForTeacher(
  teacherId: string,
  classId: string,
  studentId: string,
  month: ResourceMonth
): Promise<TeacherResourceAccessView> {
  const { cls, enrolment } = await ownedActiveEnrolment(teacherId, classId, studentId);
  return teacherView(cls, enrolment.student, month);
}

/** GRANTED / REVOKED upserts the override; DEFAULT removes it. Returns the new effective access. */
export async function setResourceAccessOverride(
  teacherId: string,
  classId: string,
  studentId: string,
  month: ResourceMonth,
  choice: ResourceAccessChoice
): Promise<TeacherResourceAccessView> {
  const { cls, enrolment } = await ownedActiveEnrolment(teacherId, classId, studentId);
  const where = { classStudentId: enrolment.id, year: month.year, month: month.month };
  if (choice === "DEFAULT") {
    await prisma.classStudentResourceAccess.deleteMany({ where });
  } else {
    await prisma.classStudentResourceAccess.upsert({
      where: { classStudentId_year_month: where },
      create: { ...where, access: choice, setByTeacherId: teacherId },
      update: { access: choice, setByTeacherId: teacherId },
    });
  }
  return teacherView(cls, enrolment.student, month);
}
