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

export async function selectTeacherSubscriptionPlan(
  teacherId: string,
  planId: string
) {
  const plan = await prisma.subscriptionPlan.findUnique({
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

  const existing = await prisma.teacherSubscription.findFirst({
    where: { teacherId },
    orderBy: { updatedAt: "desc" },
  });

  // Pre-confirmation, a teacher is just choosing/changing a plan — there is
  // no billing history to preserve yet, so the current selection is updated
  // in place rather than creating a new row every time they change their mind.
  const subscription = existing
    ? await prisma.teacherSubscription.update({
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
    : await prisma.teacherSubscription.create({
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

  return {
    ...subscription,
    price: subscription.price.toNumber(),
    plan: serializePlan(subscription.plan),
  };
}
