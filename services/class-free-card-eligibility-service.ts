import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";
import { logError } from "@/lib/error-logging/server-logger";
import {
  assertTeacherOwnsClass,
  FREE_CARD_MAX_FEES,
  type FreeCardResult,
  isLockContention,
  issueFreeCardsForEligibleEnrolments,
} from "@/services/class-student-fee-service";

/**
 * Class-level automatic Free Card eligibility (ClassStudent.freeCardEligible):
 * the teacher's bulk enable / disable for enrolments of one class, and the
 * optional "also apply to this month" on enable.
 *
 * Eligibility only decides NEW current-month fee rows (see
 * automaticFreeCardColumns in class-student-fee-service.ts). Changing it never
 * touches an existing fee: disabling revokes nothing, and enabling cards
 * existing current-month fees only when the teacher explicitly asks, through
 * issueFreeCardsForEligibleEnrolments (setFreeCards' locks and checks).
 */

const ELIGIBILITY_LOCK_TIMEOUT_MS = 3_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const FREE_CARD_ELIGIBILITY_MAX_ENROLMENTS = FREE_CARD_MAX_FEES;

export type FreeCardEligibilityRequest = {
  classStudentIds: string[];
  eligible: boolean;
  applyToCurrentMonth: boolean;
};

export type FreeCardEligibilityApply =
  | { status: "APPLIED"; processed: FreeCardResult["processed"]; skipped: FreeCardResult["skipped"] }
  | { status: "FAILED"; code: string; message: string };

export type FreeCardEligibilityResult = {
  classId: string;
  eligible: boolean;
  /** The selected enrolments with their eligibility as committed, in request order. */
  enrolments: { classStudentId: string; studentId: string; freeCardEligible: boolean }[];
  /** How many of them actually changed (the rest already had the value). */
  changedCount: number;
  /** The optional current-month application; null when not requested. */
  apply: FreeCardEligibilityApply | null;
};

/** Validates the body: { classStudentIds: string[], eligible: boolean, applyToCurrentMonth?: boolean }. */
export function parseFreeCardEligibilityRequest(body: unknown): FreeCardEligibilityRequest {
  const input = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const ids = input.classStudentIds;

  if (typeof input.eligible !== "boolean") {
    throw new AppError("eligible must be true or false.", 400, "VALIDATION_ERROR");
  }
  if (input.applyToCurrentMonth !== undefined && typeof input.applyToCurrentMonth !== "boolean") {
    throw new AppError("applyToCurrentMonth must be true or false.", 400, "VALIDATION_ERROR");
  }
  const applyToCurrentMonth = input.applyToCurrentMonth === true;
  if (applyToCurrentMonth && !input.eligible) {
    throw new AppError("Free Cards can only be applied when enabling eligibility.", 400, "VALIDATION_ERROR");
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError("Select at least one student.", 400, "VALIDATION_ERROR");
  }
  if (ids.length > FREE_CARD_ELIGIBILITY_MAX_ENROLMENTS) {
    throw new AppError(
      `Select at most ${FREE_CARD_ELIGIBILITY_MAX_ENROLMENTS} students at a time.`,
      400,
      "VALIDATION_ERROR"
    );
  }
  if (!ids.every((id) => typeof id === "string" && UUID_PATTERN.test(id))) {
    throw new AppError("Invalid enrolment id.", 400, "VALIDATION_ERROR");
  }
  if (new Set(ids).size !== ids.length) {
    throw new AppError("Each student can be selected only once.", 400, "VALIDATION_ERROR");
  }

  return { classStudentIds: ids as string[], eligible: input.eligible, applyToCurrentMonth };
}

/**
 * Sets freeCardEligible on the selected enrolments, all or nothing:
 *
 * 1. One transaction locks every selected ClassStudent row FOR NO KEY UPDATE
 *    in ascending id order (one statement, ORDER BY "id"; fee creation and the
 *    apply step lock the same rows FOR SHARE in the same order), then
 *    verifies under the lock that each one is an ACTIVE enrolment of this
 *    class of this teacher's non-deleted student, and only then updates. Any
 *    invalid selection rejects the whole request, nothing written.
 * 2. Only after that transaction committed, and only when enabling with
 *    applyToCurrentMonth, issueFreeCardsForEligibleEnrolments runs (its own
 *    transaction; it would otherwise wait on this one's locks). A failure
 *    there is returned as apply FAILED: the committed eligibility stays.
 */
export async function setClassFreeCardEligibility(params: {
  teacherId: string;
  classId: string;
  request: FreeCardEligibilityRequest;
}): Promise<FreeCardEligibilityResult> {
  const { teacherId, classId, request } = params;
  const { classStudentIds, eligible, applyToCurrentMonth } = request;

  await assertTeacherOwnsClass(teacherId, classId);

  let updated: { enrolments: FreeCardEligibilityResult["enrolments"]; changedCount: number };
  try {
    updated = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${ELIGIBILITY_LOCK_TIMEOUT_MS}ms'`);
        const sorted = [...classStudentIds].sort();
        await tx.$queryRaw`SELECT "id" FROM "ClassStudent" WHERE "id" = ANY(${sorted}) ORDER BY "id" FOR NO KEY UPDATE`;

        // Read under the lock: ownership, class and active status are final.
        const rows = await tx.classStudent.findMany({
          where: {
            id: { in: classStudentIds },
            classId,
            class: { teacherId, status: 0 },
            student: { teacherId, status: 0 },
          },
          select: { id: true, studentId: true, isActive: true, freeCardEligible: true },
        });
        const byId = new Map(rows.map((row) => [row.id, row]));

        const unknown = classStudentIds.filter((id) => !byId.has(id));
        if (unknown.length > 0) {
          throw new AppError(
            "Some selected students are not enrolled in this class.",
            404,
            "ENROLMENT_NOT_FOUND",
            { classStudentIds: unknown }
          );
        }
        const inactive = classStudentIds.filter((id) => !byId.get(id)!.isActive);
        if (inactive.length > 0) {
          throw new AppError(
            "Some selected students are no longer active in this class.",
            409,
            "ENROLMENT_NOT_ACTIVE",
            { classStudentIds: inactive }
          );
        }

        const changedCount = rows.filter((row) => row.freeCardEligible !== eligible).length;
        await tx.classStudent.updateMany({
          where: { id: { in: classStudentIds }, classId, isActive: true },
          data: { freeCardEligible: eligible },
        });

        return {
          enrolments: classStudentIds.map((id) => ({
            classStudentId: id,
            studentId: byId.get(id)!.studentId,
            freeCardEligible: eligible,
          })),
          changedCount,
        };
      },
      { maxWait: 5_000, timeout: 15_000 }
    );
  } catch (error) {
    if (isLockContention(error)) {
      throw new AppError(
        "These students are being changed by another request. Please try again.",
        409,
        "FREE_CARD_ELIGIBILITY_BUSY"
      );
    }
    throw error;
  }

  // Committed. Never inside the transaction above (its row locks would block
  // the apply step's FOR SHARE locks on the same enrolments).
  let apply: FreeCardEligibilityApply | null = null;
  if (eligible && applyToCurrentMonth) {
    try {
      const result = await issueFreeCardsForEligibleEnrolments({ teacherId, classId, classStudentIds });
      apply = { status: "APPLIED", processed: result.processed, skipped: result.skipped };
    } catch (error) {
      if (error instanceof AppError) {
        apply = { status: "FAILED", code: error.code ?? "FREE_CARD_APPLY_FAILED", message: error.message };
      } else {
        // Unexpected: to the server error log (sanitized), never to the
        // response. The request itself still succeeds (eligibility saved).
        logError(error, {
          source: "api",
          kind: "free-card-eligibility-apply",
          route: "/api/classes/[id]/free-card-eligibility",
          method: "POST",
          statusCode: 200,
        });
        apply = {
          status: "FAILED",
          code: "FREE_CARD_APPLY_FAILED",
          message: "Free Cards could not be applied to this month's fees. Please try again.",
        };
      }
    }
  }

  return { classId, eligible, enrolments: updated.enrolments, changedCount: updated.changedCount, apply };
}

/** The response message: what was saved, and what happened to the optional apply. */
export function describeFreeCardEligibilityResult(result: FreeCardEligibilityResult): string {
  const n = result.enrolments.length;
  const students = `${n} student${n === 1 ? "" : "s"}`;
  const saved = result.eligible
    ? `Free Card eligibility enabled for ${students}.`
    : `Free Card eligibility disabled for ${students}. Existing Free Cards were not changed.`;

  if (!result.apply) return saved;
  if (result.apply.status === "FAILED") {
    return `${saved} The eligibility change was saved and has not been reverted, but applying Free Cards to this month's fees failed: ${result.apply.message}`;
  }
  const issued = result.apply.processed.length;
  return `${saved} ${issued} Free Card${issued === 1 ? "" : "s"} issued for this month${
    result.apply.skipped.length > 0 ? `, ${result.apply.skipped.length} skipped` : ""
  }.`;
}
