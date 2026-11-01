"use client";

import { useCallback, useEffect, useState } from "react";

/*
 * Administrators: the Jibri shutdown fence (lib/jibri-shutdown-gate.ts).
 * The shared mode, the worker's health and the open fences, with the
 * audited mode change and override (reasons required). Reads
 * GET /api/admin/jibri-fences; no tokens, secrets or Jitsi credentials are
 * ever shown (stream IDs and non-secret settings only; the JWT secret's
 * fingerprint only as "matches" / "differs", never its value).
 */

type WorkerHealth =
  | { healthy: true }
  | { healthy: false; status: "unavailable" | "degraded"; reason: string; fields?: string[]; error?: string };

type IdentityRow = { field: string; matches: boolean; secret: boolean; expected: string | null; reported: string | null };

type Health = {
  mode: "off" | "on" | "drain";
  modeChangedAt: string | null;
  modeChangedBy: string | null;
  worker: WorkerHealth;
  readiness: WorkerHealth;
  appConfigProblem: string | null;
  identity: IdentityRow[];
  heartbeatAt: string | null;
  workerStartedAt: string | null;
  workerVersion: string | null;
  workerConfigId: string | null;
  workerMode: string | null;
  sweepStartedAt: string | null;
  sweepCompletedAt: string | null;
  lastXmppAuthAt: string | null;
  lastRoomJoinAt: string | null;
  lastConnectionError: string | null;
  lastConnectionErrorAt: string | null;
};

type Fence = {
  sessionId: string;
  classId: string;
  lectureId: string | null;
  teacherId: string;
  isActive: boolean;
  fenceDepartureAt: string;
  state: string | null;
  attempts: number;
  lastError: string | null;
  stopSentAt: string | null;
  recorderLeftAt: string | null;
  streamInactiveAt: string | null;
  idleReadings: number;
  streamId: string | null;
  origin: string | null;
};

const when = (value: string | null) => (value ? new Date(value).toLocaleString() : "—");

const WORKER_PROBLEMS: Record<string, string> = {
  missing: "No heartbeat yet: the worker has not run.",
  stale: "The heartbeat is stale: the worker is not running (or cannot reach the database).",
  "config-unverifiable": "This app's own Jitsi settings are incomplete, so no worker can be verified.",
  "version-mismatch": "The worker runs a different version than this app expects.",
  "config-mismatch": "The worker is configured differently from this app (see the fields below).",
  "mode-mismatch": "The worker has not picked up the current mode yet.",
  "sweep-stalled": "The worker is alive but its sweeps have stopped completing.",
  "xmpp-failing": "The worker cannot log in to the expected Jitsi server.",
  "room-join-failing": "The worker cannot join classroom rooms as a moderator.",
  "xmpp-unverified": "The worker has not proved a recent login to Jitsi yet.",
};

const IDENTITY_LABELS: Record<string, string> = {
  workerVersion: "Worker version",
  jitsiDomain: "Jitsi domain",
  websocketUrl: "XMPP WebSocket URL",
  mucDomain: "MUC domain",
  recorderDomain: "Recorder domain",
  focusJid: "Jicofo focus JID",
  jwtIssuer: "JWT issuer",
  jwtAudience: "JWT audience",
  jwtSecretFingerprint: "JWT secret (fingerprint)",
};

const describeHealth = (health: WorkerHealth, mode: string) => {
  if (health.healthy) return mode === "off" ? "Not required (mode off)" : "Healthy";

  const detail = health.error ? ` (${health.error})` : "";
  return `${health.status === "degraded" ? "Degraded" : "Unavailable"}: ${WORKER_PROBLEMS[health.reason] ?? health.reason}${detail}`;
};

export function AdminJibriFences() {
  const [health, setHealth] = useState<Health | null>(null);
  const [fences, setFences] = useState<Fence[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [modeReason, setModeReason] = useState("");

  const load = useCallback(async () => {
    setError(null);

    try {
      const response = await fetch("/api/admin/jibri-fences", { cache: "no-store" });
      const body = await response.json().catch(() => null);

      if (!response.ok || !body?.success) {
        setError(body?.error ?? "Could not load the Jibri shutdown status.");
        return;
      }

      setHealth(body.data.health);
      setFences(body.data.fences);
    } catch {
      setError("Could not load the Jibri shutdown status.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (url: string, payload: object) => {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok || !body?.success) {
        setError(body?.error ?? "The request failed.");
        return false;
      }

      await load();
      return true;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {error && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-900">Worker and mode</h2>
          <button type="button" onClick={() => void load()} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
            Refresh
          </button>
        </div>

        {health && (
          <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <dt className="text-slate-500">Mode</dt>
            <dd className="font-medium text-slate-900">{health.mode} (changed {when(health.modeChangedAt)}{health.modeChangedBy ? ` by ${health.modeChangedBy}` : ""})</dd>
            <dt className="text-slate-500">Worker</dt>
            <dd className={health.worker.healthy ? "font-medium text-emerald-700" : "font-medium text-red-700"}>
              {describeHealth(health.worker, health.mode)}
            </dd>
            <dt className="text-slate-500">Ready for mode on</dt>
            <dd className={health.readiness.healthy ? "text-emerald-700" : "text-red-700"}>
              {health.readiness.healthy ? "Yes" : describeHealth(health.readiness, "on")}
            </dd>
            <dt className="text-slate-500">Liveness (heartbeat)</dt>
            <dd>{when(health.heartbeatAt)} (mode seen: {health.workerMode ?? "—"})</dd>
            <dt className="text-slate-500">Last completed sweep</dt>
            <dd>{when(health.sweepCompletedAt)} (began {when(health.sweepStartedAt)})</dd>
            <dt className="text-slate-500">Last Jitsi login (expected server)</dt>
            <dd>{when(health.lastXmppAuthAt)}</dd>
            <dt className="text-slate-500">Last room join as moderator</dt>
            <dd>{when(health.lastRoomJoinAt)}</dd>
            <dt className="text-slate-500">Last connection error</dt>
            <dd>{health.lastConnectionError ? `${health.lastConnectionError} at ${when(health.lastConnectionErrorAt)}` : "—"}</dd>
            <dt className="text-slate-500">Worker</dt>
            <dd>{health.workerVersion ?? "—"}, config {health.workerConfigId ?? "—"}, started {when(health.workerStartedAt)}</dd>
          </dl>
        )}

        {health?.appConfigProblem && (
          <p className="mt-3 text-sm text-red-700">This app cannot verify the worker: {health.appConfigProblem}.</p>
        )}

        {health && (
          <table className="mt-4 w-full text-left text-sm">
            <thead>
              <tr className="text-slate-500">
                <th className="py-1 pr-3 font-normal">Setting</th>
                <th className="py-1 pr-3 font-normal">This app expects</th>
                <th className="py-1 pr-3 font-normal">Worker reports</th>
                <th className="py-1 font-normal">Match</th>
              </tr>
            </thead>
            <tbody>
              {health.identity.map((row) => (
                <tr key={row.field} className={row.matches ? "" : "bg-red-50"}>
                  <td className="py-1 pr-3">{IDENTITY_LABELS[row.field] ?? row.field}</td>
                  <td className="break-all py-1 pr-3">{row.secret ? "(not shown)" : row.expected ?? "—"}</td>
                  <td className="break-all py-1 pr-3">{row.secret ? "(not shown)" : row.reported ?? "—"}</td>
                  <td className={row.matches ? "py-1 text-emerald-700" : "py-1 font-medium text-red-700"}>
                    {row.matches ? "matches" : "differs"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="mt-4 space-y-2">
          <label className="block text-sm text-slate-600" htmlFor="jibri-mode-reason">Reason for a mode change (required)</label>
          <input
            id="jibri-mode-reason"
            value={modeReason}
            onChange={(event) => setModeReason(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap gap-2">
            {(["on", "drain", "off"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                disabled={busy || health?.mode === mode || (mode === "on" && !health?.readiness.healthy)}
                onClick={() => void post("/api/admin/jibri-fences/mode", { mode, reason: modeReason }).then((ok) => ok && setModeReason(""))}
                className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
              >
                Set {mode}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            On is refused unless the worker is ready (alive, same version and configuration as this app, sweeping,
            and recently logged in to the expected Jitsi server). To switch off: set drain, wait for the open fences
            to clear (or override them), then set off.
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Open fences ({fences.length})</h2>

        {fences.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No teacher is blocked.</p>
        ) : (
          <ul className="mt-3 space-y-4">
            {fences.map((fence) => (
              <li key={fence.sessionId} className="rounded-xl border border-slate-200 p-4 text-sm">
                <p className="font-medium text-slate-900">
                  Teacher {fence.teacherId} · session {fence.sessionId} ({fence.isActive ? "active" : "ended"})
                </p>
                <p className="mt-1 text-slate-600">
                  State {fence.state ?? "—"} ({fence.origin ?? "—"}) · since {when(fence.fenceDepartureAt)} · attempts {fence.attempts}
                  {fence.lastError ? ` · last ${fence.lastError}` : ""} · STOP sent {when(fence.stopSentAt)} ·
                  recorder left {when(fence.recorderLeftAt)} · idle readings {fence.idleReadings} · stream {fence.streamId ?? "unknown"}
                </p>

                <label className="mt-3 block text-slate-600" htmlFor={`reason-${fence.sessionId}`}>
                  Override reason (what you checked on the Jibri server and YouTube)
                </label>
                <input
                  id={`reason-${fence.sessionId}`}
                  value={reasons[fence.sessionId] ?? ""}
                  onChange={(event) => setReasons((current) => ({ ...current, [fence.sessionId]: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void post(`/api/admin/jibri-fences/${encodeURIComponent(fence.sessionId)}/override`, {
                    reason: reasons[fence.sessionId] ?? "",
                  })}
                  className="mt-2 rounded-lg bg-red-600 px-3 py-1.5 font-semibold text-white disabled:opacity-40"
                >
                  Release (audited override)
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
