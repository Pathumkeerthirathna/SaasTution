import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import {
  Prisma,
  SubscriptionInterval,
  SubscriptionPlanStatus,
} from "@prisma/client";

const INTERVAL_VALUES: SubscriptionInterval[] = ["MONTHLY", "YEARLY"];
const STATUS_VALUES: SubscriptionPlanStatus[] = ["ACTIVE", "INACTIVE"];

export interface SubscriptionPlanInput {
  name: string;
  description?: string | null;
  price: number;
  currency?: string;
  interval: SubscriptionInterval;
  maxLiveParticipants: number;
  unlimitedLiveSessions: boolean;
  unlimitedRecording: boolean;
  unlimitedStudents: boolean;
  maxTeachers?: number | null;
  storageGB?: number | null;
  status?: SubscriptionPlanStatus;
  sortOrder?: number;
}

function validateInput(input: SubscriptionPlanInput) {
  if (!input.name?.trim()) {
    throw new AppError("Plan name is required.", 400, "VALIDATION_ERROR");
  }

  if (typeof input.price !== "number" || Number.isNaN(input.price) || input.price < 0) {
    throw new AppError("Price must be a positive number.", 400, "VALIDATION_ERROR");
  }

  if (!INTERVAL_VALUES.includes(input.interval)) {
    throw new AppError("Invalid billing interval.", 400, "VALIDATION_ERROR");
  }

  if (
    typeof input.maxLiveParticipants !== "number" ||
    !Number.isInteger(input.maxLiveParticipants) ||
    input.maxLiveParticipants < 1
  ) {
    throw new AppError(
      "Max live participants must be a whole number of at least 1.",
      400,
      "VALIDATION_ERROR"
    );
  }

  if (
    input.maxTeachers != null &&
    (!Number.isInteger(input.maxTeachers) || input.maxTeachers < 1)
  ) {
    throw new AppError(
      "Max teachers must be a positive whole number.",
      400,
      "VALIDATION_ERROR"
    );
  }

  if (
    input.storageGB != null &&
    (!Number.isInteger(input.storageGB) || input.storageGB < 1)
  ) {
    throw new AppError(
      "Storage must be a positive whole number.",
      400,
      "VALIDATION_ERROR"
    );
  }

  if (input.status && !STATUS_VALUES.includes(input.status)) {
    throw new AppError("Invalid plan status.", 400, "VALIDATION_ERROR");
  }
}

function buildData(input: SubscriptionPlanInput) {
  return {
    name: input.name.trim(),
    description: input.description?.trim() || null,
    price: input.price,
    currency: input.currency?.trim() || "LKR",
    interval: input.interval,
    maxLiveParticipants: input.maxLiveParticipants,
    unlimitedLiveSessions: input.unlimitedLiveSessions,
    unlimitedRecording: input.unlimitedRecording,
    unlimitedStudents: input.unlimitedStudents,
    maxTeachers: input.maxTeachers ?? null,
    storageGB: input.storageGB ?? null,
    status: input.status ?? SubscriptionPlanStatus.ACTIVE,
    sortOrder: input.sortOrder ?? 0,
  };
}

function serializePlan<
  T extends { price: Prisma.Decimal; _count?: { subscriptions: number } }
>(plan: T) {
  const { _count, ...rest } = plan;

  return {
    ...rest,
    price: plan.price.toNumber(),
    subscriberCount: _count?.subscriptions ?? 0,
  };
}

export async function listSubscriptionPlansForAdmin() {
  const plans = await prisma.subscriptionPlan.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: {
      _count: {
        select: { subscriptions: true },
      },
    },
  });

  return plans.map(serializePlan);
}

export async function createSubscriptionPlan(input: SubscriptionPlanInput) {
  validateInput(input);

  try {
    const plan = await prisma.subscriptionPlan.create({
      data: buildData(input),
      include: { _count: { select: { subscriptions: true } } },
    });

    return serializePlan(plan);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new AppError(
        "A plan with this name already exists.",
        409,
        "PLAN_NAME_EXISTS"
      );
    }

    throw error;
  }
}

export async function updateSubscriptionPlan(
  id: string,
  input: SubscriptionPlanInput
) {
  validateInput(input);

  const existing = await prisma.subscriptionPlan.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError("Subscription plan not found.", 404, "PLAN_NOT_FOUND");
  }

  try {
    const plan = await prisma.subscriptionPlan.update({
      where: { id },
      data: buildData(input),
      include: { _count: { select: { subscriptions: true } } },
    });

    return serializePlan(plan);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new AppError(
        "A plan with this name already exists.",
        409,
        "PLAN_NAME_EXISTS"
      );
    }

    throw error;
  }
}

export async function setSubscriptionPlanStatus(
  id: string,
  status: SubscriptionPlanStatus
) {
  const existing = await prisma.subscriptionPlan.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError("Subscription plan not found.", 404, "PLAN_NOT_FOUND");
  }

  const plan = await prisma.subscriptionPlan.update({
    where: { id },
    data: { status },
    include: { _count: { select: { subscriptions: true } } },
  });

  return serializePlan(plan);
}
