"use client";

import { useEffect, useState } from "react";
import {
  Ban,
  CheckCircle2,
  HardDrive,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import toast from "react-hot-toast";

type Interval = "MONTHLY" | "YEARLY";
type PlanStatus = "ACTIVE" | "INACTIVE";

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
  status: PlanStatus;
  sortOrder: number;
  subscriberCount: number;
};

type PlanFormState = {
  name: string;
  description: string;
  price: string;
  currency: string;
  interval: Interval;
  maxLiveParticipants: string;
  unlimitedLiveSessions: boolean;
  unlimitedRecording: boolean;
  unlimitedStudents: boolean;
  maxTeachers: string;
  storageGB: string;
  status: PlanStatus;
  sortOrder: string;
};

const EMPTY_FORM: PlanFormState = {
  name: "",
  description: "",
  price: "",
  currency: "LKR",
  interval: "MONTHLY",
  maxLiveParticipants: "",
  unlimitedLiveSessions: true,
  unlimitedRecording: true,
  unlimitedStudents: true,
  maxTeachers: "",
  storageGB: "",
  status: "ACTIVE",
  sortOrder: "0",
};

function planToForm(plan: SubscriptionPlan): PlanFormState {
  return {
    name: plan.name,
    description: plan.description ?? "",
    price: String(plan.price),
    currency: plan.currency,
    interval: plan.interval,
    maxLiveParticipants: String(plan.maxLiveParticipants),
    unlimitedLiveSessions: plan.unlimitedLiveSessions,
    unlimitedRecording: plan.unlimitedRecording,
    unlimitedStudents: plan.unlimitedStudents,
    maxTeachers: plan.maxTeachers != null ? String(plan.maxTeachers) : "",
    storageGB: plan.storageGB != null ? String(plan.storageGB) : "",
    status: plan.status,
    sortOrder: String(plan.sortOrder),
  };
}

function formToPayload(form: PlanFormState) {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    price: Number(form.price),
    currency: form.currency.trim() || "LKR",
    interval: form.interval,
    maxLiveParticipants: Number(form.maxLiveParticipants),
    unlimitedLiveSessions: form.unlimitedLiveSessions,
    unlimitedRecording: form.unlimitedRecording,
    unlimitedStudents: form.unlimitedStudents,
    maxTeachers: form.maxTeachers.trim() ? Number(form.maxTeachers) : null,
    storageGB: form.storageGB.trim() ? Number(form.storageGB) : null,
    status: form.status,
    sortOrder: form.sortOrder.trim() ? Number(form.sortOrder) : 0,
  };
}

export function AdminSubscriptionPlansPanel() {
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<SubscriptionPlan | null>(null);
  const [form, setForm] = useState<PlanFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [actingId, setActingId] = useState<string | null>(null);

  async function loadPlans() {
    setLoading(true);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/admin/subscription-plans");
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        throw new Error(
          payload.error?.message ?? "Unable to load subscription plans."
        );
      }

      setPlans(payload.data.plans as SubscriptionPlan[]);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to load subscription plans."
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPlans();
  }, []);

  function openAddDrawer() {
    setEditingPlan(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setDrawerOpen(true);
  }

  function openEditDrawer(plan: SubscriptionPlan) {
    setEditingPlan(plan);
    setForm(planToForm(plan));
    setFormError(null);
    setDrawerOpen(true);
  }

  async function submitForm() {
    if (!form.name.trim()) {
      setFormError("Plan name is required.");
      return;
    }

    if (
      !form.price.trim() ||
      Number.isNaN(Number(form.price)) ||
      Number(form.price) < 0
    ) {
      setFormError("Enter a valid price.");
      return;
    }

    if (
      !form.maxLiveParticipants.trim() ||
      !Number.isInteger(Number(form.maxLiveParticipants)) ||
      Number(form.maxLiveParticipants) < 1
    ) {
      setFormError("Enter a valid max live participants value.");
      return;
    }

    setSaving(true);
    setFormError(null);

    try {
      const url = editingPlan
        ? `/api/admin/subscription-plans/${editingPlan.id}`
        : "/api/admin/subscription-plans";
      const method = editingPlan ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formToPayload(form)),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        throw new Error(payload.error?.message ?? "Failed to save plan.");
      }

      toast.success(editingPlan ? "Plan updated." : "Plan created.");
      setDrawerOpen(false);
      await loadPlans();
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "Failed to save plan."
      );
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(plan: SubscriptionPlan) {
    setActingId(plan.id);

    try {
      if (plan.status === "ACTIVE") {
        const response = await fetch(
          `/api/admin/subscription-plans/${plan.id}`,
          { method: "DELETE" }
        );
        const payload = await response.json();

        if (!response.ok || !payload.success) {
          throw new Error(payload.error?.message ?? "Failed to remove plan.");
        }

        toast.success("Plan removed.");
      } else {
        const response = await fetch(
          `/api/admin/subscription-plans/${plan.id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...formToPayload(planToForm(plan)),
              status: "ACTIVE",
            }),
          }
        );
        const payload = await response.json();

        if (!response.ok || !payload.success) {
          throw new Error(payload.error?.message ?? "Failed to restore plan.");
        }

        toast.success("Plan restored.");
      }

      await loadPlans();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setActingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-[16px] font-semibold text-slate-900">
            Subscription Plans
          </h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            Create, update or remove the packages teachers can subscribe to.
          </p>
        </div>

        <button
          type="button"
          onClick={openAddDrawer}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-brand-700"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Plan
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center rounded-2xl border border-slate-200 bg-white p-10 text-sm text-slate-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading subscription plans...
        </div>
      )}

      {!loading && errorMessage && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      {!loading && !errorMessage && plans.length === 0 && (
        <div className="flex min-h-[160px] items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white text-[13px] text-slate-400">
          No subscription plans yet. Click &quot;Add Plan&quot; to create one.
        </div>
      )}

      {!loading && !errorMessage && plans.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {plans.map((plan) => {
            const isActing = actingId === plan.id;
            const isInactive = plan.status === "INACTIVE";

            const features: string[] = [
              `Up to ${plan.maxLiveParticipants} live participants`,
              plan.unlimitedLiveSessions
                ? "Unlimited live sessions"
                : "Limited live sessions",
              plan.unlimitedRecording
                ? "Unlimited recording"
                : "Limited recording",
              plan.unlimitedStudents
                ? "Unlimited students"
                : "Limited students",
              plan.maxTeachers != null
                ? `${plan.maxTeachers} teacher${plan.maxTeachers === 1 ? "" : "s"}`
                : "Unlimited teachers",
            ];

            return (
              <div
                key={plan.id}
                className={`group relative flex flex-col overflow-hidden rounded-2xl border bg-white shadow-sm transition hover:shadow-md ${
                  isInactive
                    ? "border-dashed border-slate-300 bg-slate-50/50"
                    : "border-slate-200"
                }`}
              >
                {/* Top accent */}
                <div
                  className={`h-1 w-full ${
                    isInactive
                      ? "bg-slate-200"
                      : "bg-gradient-to-r from-brand-500 via-brand-600 to-brand-700"
                  }`}
                />

                <div className="flex flex-1 flex-col p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                          isInactive
                            ? "bg-slate-100 text-slate-400"
                            : "bg-brand-50 text-brand-600"
                        }`}
                      >
                        <Sparkles className="h-4 w-4" />
                      </span>
                      <p className="truncate text-[15px] font-bold text-slate-900">
                        {plan.name}
                      </p>
                    </div>

                    <span
                      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        isInactive
                          ? "bg-slate-100 text-slate-500"
                          : "bg-emerald-50 text-emerald-700"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          isInactive ? "bg-slate-400" : "bg-emerald-500"
                        }`}
                      />
                      {isInactive ? "Inactive" : "Active"}
                    </span>
                  </div>

                  {/* Price */}
                  <div className="mt-4 flex items-baseline gap-1">
                    <span className="text-[12px] font-semibold text-slate-400">
                      {plan.currency}
                    </span>
                    <span className="text-[28px] font-extrabold leading-none tracking-tight text-slate-900">
                      {plan.price.toLocaleString(undefined, {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                    <span className="text-[12px] font-medium text-slate-400">
                      / {plan.interval === "MONTHLY" ? "mo" : "yr"}
                    </span>
                  </div>

                  {plan.description && (
                    <p className="mt-2 line-clamp-2 text-[12px] leading-4 text-slate-500">
                      {plan.description}
                    </p>
                  )}

                  {/* Features */}
                  <ul className="mt-4 space-y-2 border-t border-slate-100 pt-4 text-[12.5px] text-slate-700">
                    {features.map((feature) => (
                      <li key={feature} className="flex items-start gap-2">
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                        {feature}
                      </li>
                    ))}
                    <li className="flex items-start gap-2">
                      <HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                      {plan.storageGB != null
                        ? `${plan.storageGB} GB storage`
                        : "Unlimited storage"}
                    </li>
                  </ul>

                  {/* Footer */}
                  <div className="mt-4 flex items-center justify-between gap-2 border-t border-slate-100 pt-3.5">
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-400">
                      <Users className="h-3 w-3" />
                      {plan.subscriberCount} subscriber
                      {plan.subscriberCount === 1 ? "" : "s"}
                    </span>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => openEditDrawer(plan)}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 shadow-sm transition hover:border-slate-400 hover:bg-slate-50"
                      >
                        <Pencil className="h-3 w-3" />
                        Edit
                      </button>

                      {isInactive ? (
                        <button
                          type="button"
                          disabled={isActing}
                          onClick={() => toggleStatus(plan)}
                          className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-2.5 py-1.5 text-[11px] font-semibold text-white shadow-sm transition hover:bg-emerald-600 disabled:opacity-50"
                        >
                          <RotateCcw className="h-3 w-3" />
                          Restore
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={isActing}
                          onClick={() => toggleStatus(plan)}
                          className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-red-600 shadow-sm transition hover:bg-red-50 disabled:opacity-50"
                        >
                          <Ban className="h-3 w-3" />
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add / Edit drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-[100]">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
          />

          <div className="absolute right-0 top-0 flex h-screen w-full max-w-lg flex-col overflow-y-auto bg-white shadow-2xl">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3.5">
              <div>
                <h2 className="text-[15px] font-bold text-slate-900">
                  {editingPlan ? "Edit Plan" : "Add Plan"}
                </h2>
                <p className="mt-0.5 text-[12.5px] text-slate-500">
                  {editingPlan
                    ? `Update details for ${editingPlan.name}.`
                    : "Create a new subscription package."}
                </p>
              </div>

              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded-md p-1.5 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  Plan Name *
                </label>
                <input
                  value={form.name}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, name: e.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-brand-500"
                  placeholder="e.g. Pro"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  Description
                </label>
                <textarea
                  rows={2}
                  value={form.description}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, description: e.target.value }))
                  }
                  className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-brand-500"
                  placeholder="Short summary shown to teachers"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                    Price *
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={form.price}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, price: e.target.value }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-brand-500"
                    placeholder="2500.00"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                    Currency
                  </label>
                  <input
                    value={form.currency}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, currency: e.target.value }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-brand-500"
                    placeholder="LKR"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                    Billing
                  </label>
                  <select
                    value={form.interval}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        interval: e.target.value as Interval,
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-brand-500"
                  >
                    <option value="MONTHLY">Monthly</option>
                    <option value="YEARLY">Yearly</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  Max Live Participants *
                </label>
                <input
                  type="number"
                  min={1}
                  value={form.maxLiveParticipants}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      maxLiveParticipants: e.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-brand-500"
                  placeholder="50"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                    Max Teachers
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={form.maxTeachers}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, maxTeachers: e.target.value }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-brand-500"
                    placeholder="Leave blank for unlimited"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                    Storage (GB)
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={form.storageGB}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, storageGB: e.target.value }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-brand-500"
                    placeholder="Leave blank for unlimited"
                  />
                </div>
              </div>

              <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                {(
                  [
                    ["unlimitedLiveSessions", "Unlimited live sessions"],
                    ["unlimitedRecording", "Unlimited recording"],
                    ["unlimitedStudents", "Unlimited students"],
                  ] as const
                ).map(([key, label]) => (
                  <label
                    key={key}
                    className="flex items-center justify-between text-[13px] text-slate-700"
                  >
                    {label}
                    <input
                      type="checkbox"
                      checked={form[key]}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, [key]: e.target.checked }))
                      }
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                  </label>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                    Status
                  </label>
                  <select
                    value={form.status}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        status: e.target.value as PlanStatus,
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-brand-500"
                  >
                    <option value="ACTIVE">Active</option>
                    <option value="INACTIVE">Inactive</option>
                  </select>
                </div>

                <div>
                  <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                    Sort Order
                  </label>
                  <input
                    type="number"
                    value={form.sortOrder}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, sortOrder: e.target.value }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-brand-500"
                  />
                </div>
              </div>

              {formError && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">
                  {formError}
                </p>
              )}
            </div>

            <div className="sticky bottom-0 mt-auto flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3.5">
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                disabled={saving}
                className="rounded-md border border-slate-300 px-3.5 py-1.5 text-[13px] font-medium text-slate-600 hover:bg-white disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitForm()}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3.5 py-1.5 text-[13px] font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {saving ? "Saving..." : editingPlan ? "Save Changes" : "Create Plan"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
