import { SubscriptionPlanStatus } from "@prisma/client";

import { logError } from "@/lib/error-logging/server-logger";
import { prisma } from "@/lib/prisma";

/*
 * The public pricing catalogue (/pricing): ACTIVE subscription plans only, in
 * the catalogue order (sortOrder, then creation), with only the fields the
 * public page shows. Prices, capacities and features always come from the
 * SubscriptionPlan rows; nothing is hard-coded. INACTIVE plans (e.g. custom
 * plans assigned by an administrator) are never returned.
 */

export type PublicPlan = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  interval: string;
  maxLiveParticipants: number;
  unlimitedLiveSessions: boolean;
  unlimitedRecording: boolean;
  unlimitedStudents: boolean;
  /** null = no plan storage limit. */
  storageGB: number | null;
};

export async function getPublicSubscriptionPlans(): Promise<PublicPlan[]> {
  const plans = await prisma.subscriptionPlan.findMany({
    where: { status: SubscriptionPlanStatus.ACTIVE },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      price: true,
      currency: true,
      interval: true,
      maxLiveParticipants: true,
      unlimitedLiveSessions: true,
      unlimitedRecording: true,
      unlimitedStudents: true,
      storageGB: true,
    },
  });
  return plans.map((plan) => ({ ...plan, price: plan.price.toNumber() }));
}

export type PricingState = { kind: "ready"; plans: PublicPlan[] } | { kind: "error" };

/**
 * The page's data: the plans, or "error" (logged) when they cannot be read, so
 * the page can still render with its own error message instead of failing.
 */
export async function loadPricingState(load: () => Promise<PublicPlan[]> = getPublicSubscriptionPlans): Promise<PricingState> {
  try {
    return { kind: "ready", plans: await load() };
  } catch (error) {
    logError(error, { source: "server", kind: "pricing-plans-load", route: "/pricing", method: "GET" });
    return { kind: "error" };
  }
}
