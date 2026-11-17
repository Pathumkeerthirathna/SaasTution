import { SubscriptionStatus, type Prisma } from "@prisma/client";

import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { assertTeacherIdFormat, type AdminIdentity } from "@/services/admin-teacher-storage-service";

/*
 * Admin teacher detail: the administrator's view and assignment of one
 * teacher's subscription plan (GET / PUT /api/admin/teachers/[teacherId]/subscription).
 *
 * - The plan's price and currency are always read from the SubscriptionPlan
 *   row; the request only names the plan. Any other field in the body (a
 *   price, a currency, dates) is ignored.
 * - Any plan may be assigned, ACTIVE or INACTIVE (e.g. a custom plan that
 *   teachers cannot pick themselves).
 * - The change runs in ONE transaction that first locks the teacher row
 *   (SELECT ... FOR UPDATE), the same lock the teacher's own plan selection
 *   takes (services/teacher-subscription-service.ts), so the two never
 *   interleave.
 * - An existing subscription keeps its startDate, endDate and autoRenew; only
 *   planId, price, currency and status (ACTIVE) change. A teacher without one
 *   gets a new ACTIVE subscription starting now, with no end date (the same
 *   defaults as the teacher's own selection).
 * - Assigning a plan records no payment and says nothing about one.
 * - There is no subscription history table: each assignment is written to the
 *   server log (administrator, teacher, previous and new plan).
 */

const PLAN_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const teacherNotFound = () => new AppError("Teacher not found.", 404, "TEACHER_NOT_FOUND");
const planNotFound = () => new AppError("Subscription plan not found.", 404, "PLAN_NOT_FOUND");

export type AdminPlanOption = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  interval: string;
  maxLiveParticipants: number;
  storageGB: number | null;
  status: string;
};

export type AdminTeacherSubscription = {
  id: string;
  planId: string;
  planName: string;
  planStatus: string;
  interval: string;
  status: string;
  price: number;
  currency: string;
  startDate: string;
  endDate: string | null;
  autoRenew: boolean;
  updatedAt: string;
} | null;

export type AdminTeacherSubscriptionSummary = {
  teacher: { id: string; name: string; email: string };
  subscription: AdminTeacherSubscription;
  /** Every plan, ACTIVE and INACTIVE, in the catalogue's order. */
  plans: AdminPlanOption[];
};

type PlanRow = {
  id: string;
  name: string;
  description: string | null;
  price: Prisma.Decimal;
  currency: string;
  interval: string;
  maxLiveParticipants: number;
  storageGB: number | null;
  status: string;
};

type SubscriptionRow = {
  id: string;
  planId: string;
  status: string;
  price: Prisma.Decimal;
  currency: string;
  startDate: Date;
  endDate: Date | null;
  autoRenew: boolean;
  updatedAt: Date;
  plan: { name: string; status: string; interval: string };
};

const serializePlan = (plan: PlanRow): AdminPlanOption => ({
  id: plan.id,
  name: plan.name,
  description: plan.description,
  price: plan.price.toNumber(),
  currency: plan.currency,
  interval: plan.interval,
  maxLiveParticipants: plan.maxLiveParticipants,
  storageGB: plan.storageGB,
  status: plan.status,
});

const serializeSubscription = (row: SubscriptionRow | null): AdminTeacherSubscription =>
  row && {
    id: row.id,
    planId: row.planId,
    planName: row.plan.name,
    planStatus: row.plan.status,
    interval: row.plan.interval,
    status: row.status,
    price: row.price.toNumber(),
    currency: row.currency,
    startDate: row.startDate.toISOString(),
    endDate: row.endDate ? row.endDate.toISOString() : null,
    autoRenew: row.autoRenew,
    updatedAt: row.updatedAt.toISOString(),
  };

/** The PUT body: { "planId": "<uuid>" }. Other fields are ignored (prices come from the plan). */
export function parseAdminSubscriptionRequest(body: unknown): { ok: true; value: { planId: string } } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "Invalid request body." };
  const planId = (body as { planId?: unknown }).planId;
  if (typeof planId !== "string" || planId.trim() === "") return { ok: false, message: "planId is required." };
  if (!PLAN_ID.test(planId.trim())) return { ok: false, message: "Invalid plan id." };
  return { ok: true, value: { planId: planId.trim() } };
}

export async function getAdminTeacherSubscription(teacherId: string): Promise<AdminTeacherSubscriptionSummary> {
  assertTeacherIdFormat(teacherId);
  const teacher = await prisma.teacher.findUnique({ where: { id: teacherId }, select: { id: true, name: true, email: true } });
  if (!teacher) throw teacherNotFound();

  const [subscription, plans] = await Promise.all([
    prisma.teacherSubscription.findFirst({
      where: { teacherId },
      orderBy: { updatedAt: "desc" },
      include: { plan: { select: { name: true, status: true, interval: true } } },
    }),
    prisma.subscriptionPlan.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
  ]);

  return { teacher, subscription: serializeSubscription(subscription), plans: plans.map(serializePlan) };
}

/**
 * Assigns `planId` to the teacher (creates the subscription or changes the
 * existing one). Nothing is written when the subscription already is ACTIVE on
 * that plan at the plan's current price and currency (changed: false).
 */
export async function assignTeacherSubscriptionPlan(input: {
  teacherId: string;
  planId: string;
  admin: AdminIdentity;
}): Promise<{ changed: boolean }> {
  assertTeacherIdFormat(input.teacherId);
  const parsed = parseAdminSubscriptionRequest({ planId: input.planId });
  if (!parsed.ok) throw new AppError(parsed.message, 400, "VALIDATION_ERROR");
  const { teacherId } = input;
  const { planId } = parsed.value;

  const outcome = await prisma.$transaction(async (tx) => {
    const [teacher] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Teacher" WHERE "id" = ${teacherId} FOR UPDATE`;
    if (!teacher) throw teacherNotFound();

    const plan = await tx.subscriptionPlan.findUnique({
      where: { id: planId },
      select: { id: true, name: true, price: true, currency: true },
    });
    if (!plan) throw planNotFound();

    const existing = await tx.teacherSubscription.findFirst({
      where: { teacherId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, planId: true, status: true, price: true, currency: true, plan: { select: { name: true } } },
    });

    if (existing) {
      const unchanged =
        existing.planId === plan.id &&
        existing.status === SubscriptionStatus.ACTIVE &&
        existing.price.equals(plan.price) &&
        existing.currency === plan.currency;
      if (unchanged) return { changed: false, previousPlan: existing.plan.name, newPlan: plan.name };

      // startDate, endDate and autoRenew are deliberately left as they are.
      await tx.teacherSubscription.update({
        where: { id: existing.id },
        data: { planId: plan.id, price: plan.price, currency: plan.currency, status: SubscriptionStatus.ACTIVE },
      });
      return { changed: true, previousPlan: existing.plan.name, newPlan: plan.name };
    }

    await tx.teacherSubscription.create({
      data: {
        teacherId,
        planId: plan.id,
        price: plan.price,
        currency: plan.currency,
        status: SubscriptionStatus.ACTIVE,
        startDate: new Date(),
      },
    });
    return { changed: true, previousPlan: null, newPlan: plan.name };
  });

  if (outcome.changed) {
    console.info(
      `[admin-subscription] ${input.admin.email} (${input.admin.adminId}) assigned plan "${outcome.newPlan}" to teacher ${teacherId}` +
        (outcome.previousPlan === null ? " (new subscription)" : ` (previous plan "${outcome.previousPlan}")`)
    );
  }
  return { changed: outcome.changed };
}
