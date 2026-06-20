"use client";

import { useEffect, useState } from "react";

type ConfigResponse = {
  countdownLeadMinutes: number;
  submissionGraceMinutes: number;
};

export default function PaperConfigurationPage() {
  const [countdownLeadMinutes, setCountdownLeadMinutes] = useState("30");
  const [submissionGraceMinutes, setSubmissionGraceMinutes] = useState("20");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch("/api/material-bundles/configuration", { cache: "no-store" });
        const payload = (await response.json()) as {
          success: boolean;
          data?: ConfigResponse;
          error?: { message?: string };
        };

        if (!payload.success || !payload.data) {
          setError(payload.error?.message ?? "Failed to load configuration.");
          return;
        }

        setCountdownLeadMinutes(String(payload.data.countdownLeadMinutes));
        setSubmissionGraceMinutes(String(payload.data.submissionGraceMinutes));
      } catch {
        setError("Failed to load configuration.");
      } finally {
        setIsLoading(false);
      }
    }

    void load();
  }, []);

  async function save() {
    setIsSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch("/api/material-bundles/configuration", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          countdownLeadMinutes: Number(countdownLeadMinutes),
          submissionGraceMinutes: Number(submissionGraceMinutes),
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: { message?: string };
      };

      if (!payload.success) {
        setError(payload.error?.message ?? "Failed to save configuration.");
        return;
      }

      setSuccess("Configuration saved successfully.");
    } catch {
      setError("Failed to save configuration.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="flex w-full flex-1 flex-col">
      <section className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6 lg:p-7">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">Paper Workflow Configuration</p>
        <h1 className="page-title mt-3">Countdown and Submission Timing</h1>
        <p className="page-subtitle mt-2">
          These settings control when students see countdown timers before paper start and how many minutes they can upload a PDF after paper end.
        </p>

        {isLoading ? <p className="mt-6 text-sm text-muted">Loading configuration...</p> : null}

        {!isLoading ? (
          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-semibold text-slate-700">Countdown starts before paper (minutes)</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={countdownLeadMinutes}
                onChange={(event) => setCountdownLeadMinutes(event.target.value)}
                className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-semibold text-slate-700">PDF submission grace after paper end (minutes)</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={submissionGraceMinutes}
                onChange={(event) => setSubmissionGraceMinutes(event.target.value)}
                className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
              />
            </label>
          </div>
        ) : null}

        {error ? <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        {success ? <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{success}</p> : null}

        <div className="mt-6 flex items-center justify-end">
          <button
            type="button"
            onClick={() => void save()}
            disabled={isLoading || isSaving}
            className="rounded-xl bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:opacity-60"
          >
            {isSaving ? "Saving..." : "Save Configuration"}
          </button>
        </div>
      </section>
    </div>
  );
}
