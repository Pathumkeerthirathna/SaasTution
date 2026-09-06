"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  HardDrive,
  Layers,
  Loader2,
  Sparkles,
  Users,
  Video,
} from "lucide-react";
import toast from "react-hot-toast";

type Interval = "MONTHLY" | "YEARLY";

type SubscriptionPlan = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  interval: Interval;
  maxLiveParticipants: number;
  unlimitedLiveSessions: boolean;
  unlimitedRecording: boolean;
  unlimitedStudents: boolean;
  maxTeachers: number | null;
  storageGB: number | null;
};

type CurrentSubscription = {
  id: string;
  planId: string;
  plan: SubscriptionPlan;
};

export function TeacherPlanSelection() {
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [current, setCurrent] = useState<CurrentSubscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectingId, setSelectingId] = useState<string | null>(null);

  async function loadData() {
    setLoading(true);

    try {
      const [plansRes, subRes] = await Promise.all([
        fetch("/api/teacher/subscription-plans"),
        fetch("/api/teacher/subscription"),
      ]);

      const plansPayload = await plansRes.json();
      const subPayload = await subRes.json();

      if (plansRes.ok && plansPayload.success) {
        setPlans(plansPayload.data.plans as SubscriptionPlan[]);
      }

      if (subRes.ok && subPayload.success) {
        setCurrent(subPayload.data.subscription as CurrentSubscription | null);
      }
    } catch {
      /* the page still renders without plan data */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, []);

  async function selectPlan(planId: string) {
    setSelectingId(planId);

    try {
      const response = await fetch("/api/teacher/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        throw new Error(payload.error?.message ?? "Failed to select plan.");
      }

      setCurrent(payload.data.subscription as CurrentSubscription);
      toast.success("Plan selected. Your officer will confirm it shortly.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to select plan."
      );
    } finally {
      setSelectingId(null);
    }
  }

  return (
    <section className="overflow-hidden rounded-3xl border border-amber-200 bg-white shadow-panel">
      <div className="flex items-start gap-3 border-b border-amber-200 bg-amber-50 px-6 py-5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <Clock3 className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-[15px] font-bold text-slate-900">
            Your Account Is Under Review
          </h2>
          <p className="mt-1 text-[13px] leading-5 text-slate-600">
            One of our officers will contact you soon to confirm your
            account.{" "}
            {current
              ? "You can change your selected plan below at any time before confirmation."
              : "In the meantime, choose the subscription plan you'd like to start with."}
          </p>
        </div>
      </div>

      <div className="p-5">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading available plans...
          </div>
        ) : plans.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-slate-500">
            No subscription plans are available right now.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {plans.map((plan) => {
              const isSelected = current?.planId === plan.id;
              const isSelecting = selectingId === plan.id;

              return (
                <div
                  key={plan.id}
                  className={`flex flex-col rounded-2xl border p-4 transition ${
                    isSelected
                      ? "border-brand-500 bg-brand-50/60 shadow-sm"
                      : "border-slate-200 bg-white hover:border-brand-300"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                        isSelected
                          ? "bg-brand-600 text-white"
                          : "bg-brand-50 text-brand-600"
                      }`}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                    </span>
                    <p className="text-[13.5px] font-bold text-slate-900">
                      {plan.name}
                    </p>
                  </div>

                  <div className="mt-3 flex items-baseline gap-1">
                    <span className="text-[11px] font-semibold text-slate-400">
                      {plan.currency}
                    </span>
                    <span className="text-[22px] font-extrabold leading-none tracking-tight text-slate-900">
                      {plan.price.toLocaleString(undefined, {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                    <span className="text-[11px] font-medium text-slate-400">
                      / {plan.interval === "MONTHLY" ? "mo" : "yr"}
                    </span>
                  </div>

                  {plan.description && (
                    <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-4 text-slate-500">
                      {plan.description}
                    </p>
                  )}

                  <ul className="mt-3 space-y-1.5 border-t border-slate-100 pt-3 text-[11.5px] text-slate-600">
                    <li className="flex items-start gap-1.5">
                      <Users className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
                      Up to {plan.maxLiveParticipants} live participants
                    </li>
                    <li className="flex items-start gap-1.5">
                      <Video className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
                      {plan.unlimitedLiveSessions ? "Unlimited" : "Limited"} live
                      sessions ·{" "}
                      {plan.unlimitedRecording ? "Unlimited" : "Limited"} recording
                    </li>
                    <li className="flex items-start gap-1.5">
                      <Layers className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
                      {plan.unlimitedStudents ? "Unlimited" : "Limited"} students ·{" "}
                      {plan.maxTeachers != null
                        ? `${plan.maxTeachers} teacher${plan.maxTeachers === 1 ? "" : "s"}`
                        : "Unlimited teachers"}
                    </li>
                    <li className="flex items-start gap-1.5">
                      <HardDrive className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
                      {plan.storageGB != null
                        ? `${plan.storageGB} GB storage`
                        : "Unlimited storage"}
                    </li>
                  </ul>

                  <button
                    type="button"
                    disabled={isSelected || isSelecting}
                    onClick={() => void selectPlan(plan.id)}
                    className={`mt-4 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[12.5px] font-semibold transition disabled:cursor-not-allowed ${
                      isSelected
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-brand-600 text-white hover:bg-brand-700"
                    }`}
                  >
                    {isSelecting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : isSelected ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : null}
                    {isSelecting
                      ? "Selecting..."
                      : isSelected
                      ? "Selected"
                      : current
                      ? "Switch to this plan"
                      : "Select this plan"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
