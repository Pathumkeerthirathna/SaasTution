import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { Prisma, SubscriptionPlanStatus } from "@prisma/client";

function serializePlan<T extends { price: Prisma.Decimal }>(
  plan: T
): Omit<T, "price"> & { price: number } {
  return { ...plan, price: plan.price.toNumber() };
}

export async function getActiveSubscriptionPlansForTeacher() {
  const plans = await prisma.subscriptionPlan.findMany({
    where: { status: SubscriptionPlanStatus.ACTIVE },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  return plans.map(serializePlan);
}

export async function getCurrentTeacherSubscription(teacherId: string) {
  const subscription = await prisma.teacherSubscription.findFirst({
    where: { teacherId },
    orderBy: { updatedAt: "desc" },
    include: { plan: true },
  });

  if (!subscription) return null;

  return {
    ...subscription,
    price: subscription.price.toNumber(),
    plan: serializePlan(subscription.plan),
  };
}

/**
 * A teacher's own plan selection. Only while the account is awaiting approval
 * (neither confirmed nor rejected, as the dashboard's plan picker): once an
 * administrator has approved (or rejected) the account, the teacher can no
 * longer change the plan or its price here (403 SUBSCRIPTION_CHANGE_NOT_ALLOWED);
 * later changes go through an administrator.
 *
 * The teacher row is locked (FOR UPDATE) for the whole selection, and approval
 * and rejection update that row, so a selection either completes before an
 * approval or sees it: a plan is never changed after the account was approved.
 */
export async function selectTeacherSubscriptionPlan(
  teacherId: string,
  planId: string
) {
  const subscription = await prisma.$transaction(async (tx) => {
    const [teacher] = await tx.$queryRaw<{ isConfirmed: boolean; isRejected: boolean }[]>`
      SELECT "isConfirmed", "isRejected" FROM "Teacher" WHERE "id" = ${teacherId} FOR UPDATE`;

    if (!teacher) {
      throw new AppError("Teacher account not found.", 404, "TEACHER_NOT_FOUND");
    }

    if (teacher.isConfirmed) {
      throw new AppError(
        "Your account has been approved, so your subscription plan can no longer be changed here. Please contact us to change your plan.",
        403,
        "SUBSCRIPTION_CHANGE_NOT_ALLOWED"
      );
    }

    if (teacher.isRejected) {
      throw new AppError(
        "Your account was not approved, so a subscription plan cannot be selected.",
        403,
        "SUBSCRIPTION_CHANGE_NOT_ALLOWED"
      );
    }

    const plan = await tx.subscriptionPlan.findUnique({
      where: { id: planId },
    });

    if (!plan) {
      throw new AppError("Subscription plan not found.", 404, "PLAN_NOT_FOUND");
    }

    if (plan.status !== SubscriptionPlanStatus.ACTIVE) {
      throw new AppError(
        "This plan is no longer available.",
        400,
        "PLAN_NOT_AVAILABLE"
      );
    }

    const existing = await tx.teacherSubscription.findFirst({
      where: { teacherId },
      orderBy: { updatedAt: "desc" },
    });

    // Pre-confirmation, a teacher is just choosing/changing a plan — there is
    // no billing history to preserve yet, so the current selection is updated
    // in place rather than creating a new row every time they change their mind.
    return existing
      ? await tx.teacherSubscription.update({
        where: { id: existing.id },
        data: {
          planId: plan.id,
          price: plan.price,
          currency: plan.currency,
          status: "ACTIVE",
          startDate: new Date(),
          endDate: null,
        },
        include: { plan: true },
      })
    : await tx.teacherSubscription.create({
        data: {
          teacherId,
          planId: plan.id,
          price: plan.price,
          currency: plan.currency,
          status: "ACTIVE",
          startDate: new Date(),
        },
        include: { plan: true },
      });
  });

  return {
    ...subscription,
    price: subscription.price.toNumber(),
    plan: serializePlan(subscription.plan),
  };
}
