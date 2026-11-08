import { Prisma } from "@prisma/client";

import { AppError } from "@/lib/error-handler";
import { MAX_FEE_WAIVER_RULES } from "@/lib/fee-waiver";
import type { FeeWaiverRuleInput } from "@/lib/fee-waiver-validation";
import { prisma } from "@/lib/prisma";
import { assertTeacherOwnsClass } from "@/services/class-student-fee-service";

/**
 * Teacher management of a class's sequential joining-waiver rules.
 *
 * Ownership uses the fee sheet's existing check (assertTeacherOwnsClass: the
 * signed-in teacher's active class, else 404). Rules never rewrite invoices
 * directly: the current month picks them up on the next automatic pass
 * (until its due date) and any month on an explicit Reprocess; invoices keep
 * the snapshot of the rule they used.
 */

export type FeeWaiverRuleView = {
  id: string;
  sequence: number;
  type: "PERCENTAGE" | "FIXED_AMOUNT";
  value: number;
};

const RULE_SELECT = { id: true, sequence: true, type: true, value: true } as const;

type Tx = Prisma.TransactionClient;

/** Serialises rule changes of one class (positions stay 1..n without gaps). */
async function lockClass(tx: Tx, classId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Class" WHERE "id" = ${classId} FOR UPDATE`;
}

function activeRules(db: Tx, classId: string) {
  return db.classFeeWaiverRule.findMany({
    where: { classId, status: 0 },
    orderBy: { sequence: "asc" },
    select: RULE_SELECT,
  });
}

function mapConflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new AppError("The rules were changed at the same time. Please try again.", 409, "RULE_CONFLICT");
  }
  throw error;
}

export async function listFeeWaiverRules(teacherId: string, classId: string): Promise<FeeWaiverRuleView[]> {
  await assertTeacherOwnsClass(teacherId, classId);
  return activeRules(prisma, classId);
}

export async function createFeeWaiverRule(
  teacherId: string,
  classId: string,
  input: FeeWaiverRuleInput
): Promise<FeeWaiverRuleView[]> {
  await assertTeacherOwnsClass(teacherId, classId);

  try {
    return await prisma.$transaction(async (tx) => {
      await lockClass(tx, classId);
      const rules = await activeRules(tx, classId);

      if (rules.length >= MAX_FEE_WAIVER_RULES) {
        throw new AppError(
          `A class can have at most ${MAX_FEE_WAIVER_RULES} waiver rules.`,
          409,
          "RULE_LIMIT"
        );
      }

      await tx.classFeeWaiverRule.create({
        data: {
          classId,
          sequence: (rules.at(-1)?.sequence ?? 0) + 1,
          type: input.type,
          value: input.value,
        },
      });

      return activeRules(tx, classId);
    });
  } catch (error) {
    return mapConflict(error);
  }
}

export async function updateFeeWaiverRule(
  teacherId: string,
  classId: string,
  ruleId: string,
  input: FeeWaiverRuleInput
): Promise<FeeWaiverRuleView[]> {
  await assertTeacherOwnsClass(teacherId, classId);

  return prisma.$transaction(async (tx) => {
    await lockClass(tx, classId);
    const { count } = await tx.classFeeWaiverRule.updateMany({
      where: { id: ruleId, classId, status: 0 },
      data: { type: input.type, value: input.value },
    });

    if (count === 0) {
      throw new AppError("Waiver rule not found.", 404, "RULE_NOT_FOUND");
    }

    return activeRules(tx, classId);
  });
}

/** Removes a rule (soft delete) and moves the later rules up one position. */
export async function deleteFeeWaiverRule(
  teacherId: string,
  classId: string,
  ruleId: string
): Promise<FeeWaiverRuleView[]> {
  await assertTeacherOwnsClass(teacherId, classId);

  try {
    return await prisma.$transaction(async (tx) => {
      await lockClass(tx, classId);
      const rule = await tx.classFeeWaiverRule.findFirst({
        where: { id: ruleId, classId, status: 0 },
        select: { id: true, sequence: true },
      });

      if (!rule) {
        throw new AppError("Waiver rule not found.", 404, "RULE_NOT_FOUND");
      }

      await tx.classFeeWaiverRule.update({ where: { id: rule.id }, data: { status: 1 } });

      const later = await tx.classFeeWaiverRule.findMany({
        where: { classId, status: 0, sequence: { gt: rule.sequence } },
        orderBy: { sequence: "asc" },
        select: { id: true, sequence: true },
      });

      // Ascending: each target position is already free.
      for (const entry of later) {
        await tx.classFeeWaiverRule.update({
          where: { id: entry.id },
          data: { sequence: entry.sequence - 1 },
        });
      }

      return activeRules(tx, classId);
    });
  } catch (error) {
    return mapConflict(error);
  }
}
