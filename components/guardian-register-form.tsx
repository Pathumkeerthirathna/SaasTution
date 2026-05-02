"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type ApiError = {
  message?: string;
};

export function GuardianRegisterForm() {
  const router = useRouter();
  const [form, setForm] = useState({
    guardianId: "",
    phone: "",
    email: "",
    password: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/guardian-auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(form),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: ApiError;
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to register account.");
        return;
      }

      setSuccessMessage("Registration completed. Redirecting to guardian dashboard...");
      router.push("/guardian/dashboard");
      router.refresh();
    } catch {
      setErrorMessage("Unable to register right now.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
      <div>
        <label htmlFor="guardianProfileId" className="mb-1 block text-sm font-medium">
          Guardian profile ID
        </label>
        <input
          id="guardianProfileId"
          required
          value={form.guardianId}
          onChange={(event) => setForm((prev) => ({ ...prev, guardianId: event.target.value }))}
          className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
          placeholder="Paste the guardian ID provided by teacher"
        />
      </div>

      <div>
        <label htmlFor="guardianPhone" className="mb-1 block text-sm font-medium">
          Phone
        </label>
        <input
          id="guardianPhone"
          required
          value={form.phone}
          onChange={(event) => setForm((prev) => ({ ...prev, phone: event.target.value }))}
          className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
          placeholder="Enter the same phone shared with teacher"
        />
      </div>

      <div>
        <label htmlFor="guardianEmail" className="mb-1 block text-sm font-medium">
          Email
        </label>
        <input
          id="guardianEmail"
          type="email"
          required
          value={form.email}
          onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
          className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
          placeholder="guardian@example.com"
        />
      </div>

      <div>
        <label htmlFor="guardianPassword" className="mb-1 block text-sm font-medium">
          Password
        </label>
        <input
          id="guardianPassword"
          type="password"
          required
          value={form.password}
          onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
          className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
          placeholder="At least 8 characters"
        />
      </div>

      {errorMessage ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>
      ) : null}

      {successMessage ? (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {successMessage}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full rounded-xl bg-foreground px-4 py-2.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting ? "Creating account..." : "Register guardian account"}
      </button>
    </form>
  );
}
