import type { Prisma } from "@prisma/client";

import { AppError } from "@/lib/error-handler";
import { feePaymentState, hasAwaitingSubmission, PAYMENT_STATE_SELECT, type FeePaymentState } from "@/lib/fee-payment-state";
import { prisma } from "@/lib/prisma";
import { emitStudentDataChange } from "@/lib/session-events";
import { assertTeacherOwnsClass, isLockContention } from "@/services/class-student-fee-service";

/*
 * Partial payments, Stage 2B: teacher-recorded payments and their reversal.
 *
 * Every write runs in ONE transaction that first locks the fee row
 * (SELECT ... FOR UPDATE, the lock the Free Card issue and the student slip
 * upload take) and then re-reads the fee and its payments, so the balance is
 * decided on data no concurrent payment can change underneath. The shared
 * calculation (lib/fee-payment-state.ts) decides what is outstanding.
 *
 * Never changed or deleted: an existing payment (a recorded payment is a new
 * CONFIRMED row; a reversal is a new ClassPaymentReversal row), the fee's
 * amounts, adjustments, waivers or Free Card.
 */

const LOCK_TIMEOUT_MS = 3_000;
const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;
const PAYMENT_METHODS = ["CASH", "BANK_TRANSFER", "OTHER"] as const;
const MAX_NOTE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

type Tx = Prisma.TransactionClient;

async function lockFeeRow(tx: Tx, feeId: string) {
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
  await tx.$queryRaw`SELECT "id" FROM "ClassStudentFee" WHERE "id" = ${feeId} FOR UPDATE`;
}

/** The fee and its payments, re-read under the lock. */
function readFeePosition(tx: Tx, feeId: string) {
  return tx.classStudentFee.findUnique({
    where: { id: feeId },
    select: {
      id: true,
      status: true,
      finalAmount: true,
      freeCard: true,
      classStudent: { select: { classId: true, studentId: true } },
      payments: { orderBy: { submittedAt: "desc" }, select: PAYMENT_STATE_SELECT },
    },
  });
}

function busy(error: unknown): never {
  if (isLockContention(error)) {
    throw new AppError("This fee is being changed by another request. Please try again.", 409, "PAYMENT_BUSY");
  }
  throw error;
}

const isUniqueViolation = (error: unknown) => (error as { code?: unknown } | null)?.code === "P2002";

// ---- Recording an offline payment ---------------------------------------------------------

export type RecordPaymentInput = {
  amount: number;
  paymentMethod: PaymentMethod;
  receivedAt: Date;
  note: string | null;
  requestKey: string;
};

/** Validates the request body; the server decides everything else. */
export function parseRecordPaymentRequest(body: unknown, now = new Date()): RecordPaymentInput {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const invalid = (message: string): never => {
    throw new AppError(message, 400, "VALIDATION_ERROR");
  };

  const amount = input.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) invalid("The amount must be a whole number of rupees above zero.");
  const paymentMethod = input.paymentMethod;
  if (typeof paymentMethod !== "string" || !(PAYMENT_METHODS as readonly string[]).includes(paymentMethod)) {
    invalid("The payment method must be CASH, BANK_TRANSFER or OTHER.");
  }
  const receivedAt = typeof input.receivedAt === "string" ? new Date(input.receivedAt) : null;
  if (!receivedAt || Number.isNaN(receivedAt.getTime())) invalid("The date the payment was received is required.");
  if (receivedAt!.getTime() > now.getTime() + DAY_MS) invalid("The received date cannot be in the future.");
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;
  if (note && note.length > MAX_NOTE) invalid(`The note can be at most ${MAX_NOTE} characters.`);
  if (input.note !== undefined && input.note !== null && typeof input.note !== "string") invalid("The note must be text.");
  const requestKey = input.requestKey;
  if (typeof requestKey !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(requestKey)) {
    invalid("A request key (8-100 letters, digits, '-' or '_') is required.");
  }

  return { amount: amount as number, paymentMethod: paymentMethod as PaymentMethod, receivedAt: receivedAt!, note, requestKey: requestKey as string };
}

const PAYMENT_RESULT_SELECT = {
  id: true,
  classStudentFeeId: true,
  amount: true,
  status: true,
  source: true,
  paymentMethod: true,
  receivedAt: true,
  recordedByTeacherId: true,
  note: true,
  requestKey: true,
  confirmedAt: true,
} as const;

export type RecordPaymentResult = {
  payment: Prisma.ClassPaymentGetPayload<{ select: typeof PAYMENT_RESULT_SELECT }>;
  feePayment: FeePaymentState;
  /** The same request key was already processed: nothing new was recorded. */
  replayed: boolean;
};

/** The earlier result of a request key, or a 409 when the key was used for something else. */
async function replay(teacherId: string, feeId: string, input: RecordPaymentInput): Promise<RecordPaymentResult | null> {
  const existing = await prisma.classPayment.findUnique({ where: { requestKey: input.requestKey }, select: PAYMENT_RESULT_SELECT });
  if (!existing) return null;
  if (existing.classStudentFeeId !== feeId || existing.recordedByTeacherId !== teacherId || existing.amount !== input.amount) {
    throw new AppError("This request key was already used for a different payment.", 409, "REQUEST_KEY_CONFLICT");
  }
  const fee = await prisma.classStudentFee.findUnique({
    where: { id: feeId },
    select: { finalAmount: true, freeCard: true, payments: { select: PAYMENT_STATE_SELECT } },
  });
  return { payment: existing, feePayment: feePaymentState(fee!, fee!.payments), replayed: true };
}

/**
 * Records money the teacher received directly (cash, bank transfer, other)
 * as a CONFIRMED TEACHER_RECORDED payment of one fee. Refused (409) when the
 * fee has a Free Card, nothing outstanding, a student slip awaiting
 * processing, or less outstanding than the amount. A repeated request key
 * returns the original payment.
 */
export async function recordTeacherPayment(params: {
  teacherId: string;
  classId: string;
  feeId: string;
  input: RecordPaymentInput;
}): Promise<RecordPaymentResult> {
  const { teacherId, classId, feeId, input } = params;
  await assertTeacherOwnsClass(teacherId, classId);

  const fee = await prisma.classStudentFee.findFirst({
    where: { id: feeId, classStudent: { classId, class: { teacherId } } },
    select: { id: true },
  });
  if (!fee) throw new AppError("Fee not found.", 404, "FEE_NOT_FOUND");

  const earlier = await replay(teacherId, feeId, input);
  if (earlier) return earlier;

  let result: RecordPaymentResult;
  try {
    result = await prisma.$transaction(async (tx) => {
      await lockFeeRow(tx, feeId);
      const current = await readFeePosition(tx, feeId);
      if (!current) throw new AppError("Fee not found.", 404, "FEE_NOT_FOUND");

      const before = feePaymentState(current, current.payments);
      if (current.freeCard) {
        throw new AppError("This fee has a Free Card: nothing is payable.", 409, "FREE_CARD_ACTIVE");
      }
      if (hasAwaitingSubmission(current.payments)) {
        throw new AppError(
          "A student payment slip for this fee is awaiting your review. Confirm it or ask for clarification before recording another payment.",
          409,
          "SUBMISSION_AWAITING"
        );
      }
      if (before.outstanding <= 0) {
        throw new AppError("Nothing is outstanding for this fee.", 409, "FEE_ALREADY_SETTLED", { outstanding: 0, overpaidAmount: before.overpaidAmount });
      }
      if (input.amount > before.outstanding) {
        throw new AppError(
          `The amount is more than the outstanding Rs. ${before.outstanding.toLocaleString()}.`,
          409,
          "AMOUNT_EXCEEDS_OUTSTANDING",
          { outstanding: before.outstanding }
        );
      }

      const confirmedAt = new Date();
      const payment = await tx.classPayment.create({
        data: {
          classId: current.classStudent.classId,
          studentId: current.classStudent.studentId,
          classStudentFeeId: feeId,
          amount: input.amount,
          note: input.note,
          status: "CONFIRMED",
          source: "TEACHER_RECORDED",
          paymentMethod: input.paymentMethod,
          receivedAt: input.receivedAt,
          recordedByTeacherId: teacherId,
          requestKey: input.requestKey,
          confirmedAt,
          confirmedByTeacherId: teacherId,
          submittedAt: confirmedAt,
        },
        select: PAYMENT_RESULT_SELECT,
      });

      const after = feePaymentState(current, [...current.payments, { amount: payment.amount, status: "CONFIRMED", reversal: null }]);
      return { payment, feePayment: after, replayed: false };
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    // The same request key won a concurrent race: answer with that payment.
    if (isUniqueViolation(error)) {
      const earlierNow = await replay(teacherId, feeId, input);
      if (earlierNow) return earlierNow;
    }
    busy(error);
  }

  if (!result!.replayed) {
    // Realtime: the student's payment pages refresh (as other fee changes do).
    emitStudentDataChange({ classId });
  }
  return result!;
}

// ---- Reversing a teacher-recorded payment -------------------------------------------------

export type PaymentReversalActor = { role: "TEACHER"; teacherId: string } | { role: "ADMIN"; adminId: string };

export function parseReversalRequest(body: unknown): { reason: string } {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 3 || reason.length > 500) {
    throw new AppError("A reason of 3 to 500 characters is required.", 400, "VALIDATION_ERROR");
  }
  return { reason };
}

/**
 * Reverses a TEACHER_RECORDED payment, in full, once: a ClassPaymentReversal
 * row (amount, reason, actor, time); the payment itself is left as it was and
 * simply stops counting as received. Allowed for the teacher who recorded it,
 * the class's teacher, and an administrator. The fee stays frozen (its
 * confirmed payment remains in the history).
 */
export async function reverseTeacherPayment(params: {
  actor: PaymentReversalActor;
  paymentId: string;
  /** The class in the route (teacher route); omitted by the admin route. */
  classId?: string;
  reason: string;
}): Promise<{ reversal: { id: string; paymentId: string; amount: number; reason: string; reversedByRole: string; reversedById: string; createdAt: Date }; feePayment: FeePaymentState }> {
  const { actor, paymentId, classId, reason } = params;

  const payment = await prisma.classPayment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      classId: true,
      studentId: true,
      classStudentFeeId: true,
      amount: true,
      status: true,
      source: true,
      recordedByTeacherId: true,
      class: { select: { teacherId: true } },
    },
  });

  const allowed =
    payment &&
    (classId === undefined || payment.classId === classId) &&
    (actor.role === "ADMIN" || payment.recordedByTeacherId === actor.teacherId || payment.class.teacherId === actor.teacherId);
  // Another teacher's class looks like an unknown payment (nothing revealed).
  if (!payment || !allowed) throw new AppError("Payment not found.", 404, "PAYMENT_NOT_FOUND");

  if (payment.source !== "TEACHER_RECORDED" || payment.status !== "CONFIRMED") {
    throw new AppError(
      "Only a payment recorded by the teacher can be reversed here. Student payment slips use the clarification workflow.",
      409,
      "NOT_TEACHER_RECORDED"
    );
  }

  const reversedById = actor.role === "ADMIN" ? actor.adminId : actor.teacherId;
  let result: Awaited<ReturnType<typeof reverseTeacherPayment>>;
  try {
    result = await prisma.$transaction(async (tx) => {
      await lockFeeRow(tx, payment.classStudentFeeId);
      const existing = await tx.classPaymentReversal.findUnique({ where: { paymentId }, select: { id: true } });
      if (existing) throw new AppError("This payment was already reversed.", 409, "ALREADY_REVERSED");

      const reversal = await tx.classPaymentReversal.create({
        data: { paymentId, amount: payment.amount, reason, reversedByRole: actor.role, reversedById },
        select: { id: true, paymentId: true, amount: true, reason: true, reversedByRole: true, reversedById: true, createdAt: true },
      });

      const current = await readFeePosition(tx, payment.classStudentFeeId);
      const feePayment = feePaymentState(current!, current!.payments);
      // A fee marked fully paid (status 1, Reprocess) is payable again: make
      // it visible to the student and the slip upload. Amounts are untouched.
      if (current!.status === 1 && feePayment.state !== "PAID") {
        await tx.classStudentFee.update({ where: { id: current!.id }, data: { status: 0 } });
      }
      return { reversal, feePayment };
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("This payment was already reversed.", 409, "ALREADY_REVERSED");
    busy(error);
  }

  emitStudentDataChange({ studentId: payment.studentId, classId: payment.classId });
  return result!;
}
