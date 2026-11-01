import { createHmac } from "node:crypto";

import { JITSI_HOST_NAME, jitsiJwtIssuerAudience } from "@/lib/jitsi-auth";

/*
 * Backend Jibri stop: the WORKER's start-up permission and connection
 * settings (lib/jibri-stop-for-departure.ts, scripts/jibri-stop-worker.ts).
 * JIBRI_SERVER_STOP=on here only allows the worker process to start; what
 * it does is decided by the shared mode in the database
 * (lib/jibri-fence-control.ts), which the app reads too.
 *
 * Deliberately free of Prisma and of anything that imports it: the worker
 * decides whether to run from THIS module alone, before any module that
 * touches the database is loaded. Importing @prisma/client loads the
 * project's .env into process.env (without overriding variables already
 * set), so a decision taken after that import could be enabled, and pointed
 * at a database, by .env alone. Here only the real process environment
 * counts: every required value, including DATABASE_URL, must be given to
 * the worker process explicitly (PM2 env, `tsx --env-file=...`, the shell).
 *
 * Identity: the worker reports the Jitsi target it uses (domain, WebSocket
 * URL, MUC and recorder domains, Jicofo's JID), its version, the JWT issuer
 * and audience and a non-reversible fingerprint of the JWT secret. The app
 * derives the same from ITS environment (expectedJibriWorkerIdentity) and
 * treats any difference as an unhealthy worker (lib/jibri-fence-control.ts).
 */

export type JibriStopConfig = {
  jitsiDomain: string;
  websocketUrl: string;
  mucDomain: string;
  recorderDomain: string;
  /** Jicofo's real bare JID in the room (its occupant is matched exactly). */
  focusJid: string;
};

/**
 * A short identity of the worker's non-secret Jitsi settings (for its
 * heartbeat and the administrators' view): never the token or the secret.
 */
export function jibriStopConfigId(config: JibriStopConfig): string {
  const text = [config.jitsiDomain, config.websocketUrl, config.mucDomain, config.recorderDomain, config.focusJid].join("|");
  let hash = 0x811c9dc5;

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0") + ":" + config.jitsiDomain;
}

const BARE_JID = /^[a-z0-9][a-z0-9._-]{0,62}@[a-z0-9.-]+$/;

/**
 * Enabled ONLY with JIBRI_SERVER_STOP=on, a self-hosted Jitsi domain, Jitsi
 * JWT authentication configured and DATABASE_URL, all in `env` itself.
 */
export function readJibriStopConfig(env: NodeJS.ProcessEnv = process.env):
  | { enabled: false; reason: string }
  | { enabled: true; config: JibriStopConfig } {
  if (env.JIBRI_SERVER_STOP?.trim().toLowerCase() !== "on") {
    return { enabled: false, reason: "JIBRI_SERVER_STOP is not on" };
  }

  if (!env.DATABASE_URL?.trim()) {
    return { enabled: false, reason: "DATABASE_URL must be given to the worker process explicitly" };
  }

  return resolveJibriStopTarget(env);
}

/**
 * The Jitsi target and its JWT setup from `env`, without the worker's
 * start-up permission: the worker's own settings (readJibriStopConfig) and
 * what the APP expects the worker to use (expectedJibriWorkerIdentity), with
 * the same defaults, so the two can be compared field by field.
 */
export function resolveJibriStopTarget(env: NodeJS.ProcessEnv):
  | { enabled: false; reason: string }
  | { enabled: true; config: JibriStopConfig } {
  const jitsiDomain = env.JITSI_DOMAIN?.trim().toLowerCase() ?? "";

  if (!JITSI_HOST_NAME.test(jitsiDomain) || jitsiDomain === "meet.jit.si") {
    return { enabled: false, reason: "JITSI_DOMAIN is missing or not a self-hosted Jitsi domain" };
  }

  if (env.JITSI_ENABLE_JWT_AUTH?.trim().toLowerCase() !== "true" || !env.JITSI_JWT_SECRET?.trim()) {
    return { enabled: false, reason: "Jitsi JWT authentication is not configured" };
  }

  const mucDomain = env.JITSI_MUC_DOMAIN?.trim().toLowerCase() || `conference.${jitsiDomain}`;
  const recorderDomain = env.JITSI_RECORDER_DOMAIN?.trim().toLowerCase() || `recorder.${jitsiDomain}`;
  const websocketUrl = env.JITSI_XMPP_WEBSOCKET_URL?.trim() || `wss://${jitsiDomain}/xmpp-websocket`;
  const focusJid = env.JITSI_FOCUS_JID?.trim().toLowerCase() || `focus@auth.${jitsiDomain}`;

  if (!JITSI_HOST_NAME.test(mucDomain) || !JITSI_HOST_NAME.test(recorderDomain)) {
    return { enabled: false, reason: "JITSI_MUC_DOMAIN / JITSI_RECORDER_DOMAIN is not a host name" };
  }

  if (!BARE_JID.test(focusJid) || !JITSI_HOST_NAME.test(focusJid.slice(focusJid.indexOf("@") + 1))) {
    return { enabled: false, reason: "JITSI_FOCUS_JID is not a bare JID" };
  }

  try {
    if (new URL(websocketUrl).protocol !== "wss:") {
      return { enabled: false, reason: "JITSI_XMPP_WEBSOCKET_URL must use wss:" };
    }
  } catch {
    return { enabled: false, reason: "JITSI_XMPP_WEBSOCKET_URL is not a URL" };
  }

  return { enabled: true, config: { jitsiDomain, websocketUrl, mucDomain, recorderDomain, focusJid } };
}

// ---- The worker's identity, as the app checks it --------------------------------------------------

/** Bumped whenever the worker's behaviour or its heartbeat changes. */
export const JIBRI_WORKER_VERSION = "jibri-stop-worker/3";

/** A fixed label: the fingerprint is an HMAC of it, keyed with the JWT secret. */
const FINGERPRINT_LABEL = "slclassroom/jibri-stop/jwt-secret-fingerprint/v1";

/**
 * A NON-REVERSIBLE fingerprint of the Jitsi JWT secret: HMAC-SHA256 of a
 * fixed label keyed with the secret, truncated (64 bits). Equal secrets give
 * equal fingerprints; the secret cannot be recovered from it, and it is
 * never displayed (only "matches" / "differs").
 */
export function jibriJwtSecretFingerprint(secret: string): string {
  return createHmac("sha256", secret).update(FINGERPRINT_LABEL).digest("hex").slice(0, 16);
}

/**
 * Everything the app compares between itself and the worker. All but the
 * fingerprint are plain, non-secret settings (shown to administrators).
 */
export type JibriWorkerIdentity = {
  workerVersion: string;
  jitsiDomain: string;
  websocketUrl: string;
  mucDomain: string;
  recorderDomain: string;
  focusJid: string;
  jwtIssuer: string;
  jwtAudience: string;
  jwtSecretFingerprint: string;
};

export const JIBRI_IDENTITY_FIELDS = [
  "workerVersion",
  "jitsiDomain",
  "websocketUrl",
  "mucDomain",
  "recorderDomain",
  "focusJid",
  "jwtIssuer",
  "jwtAudience",
  "jwtSecretFingerprint",
] as const satisfies readonly (keyof JibriWorkerIdentity)[];

export type JibriIdentityField = (typeof JIBRI_IDENTITY_FIELDS)[number];

/** Fields whose values are never shown (only whether they match). */
export const JIBRI_SECRET_IDENTITY_FIELDS: readonly JibriIdentityField[] = ["jwtSecretFingerprint"];

/** The identity of a worker running with `config` and `env` (its own process environment). */
export function jibriWorkerIdentity(config: JibriStopConfig, env: NodeJS.ProcessEnv): JibriWorkerIdentity {
  const { issuer, audience } = jitsiJwtIssuerAudience(env);

  return {
    workerVersion: JIBRI_WORKER_VERSION,
    ...config,
    jwtIssuer: issuer,
    jwtAudience: audience,
    jwtSecretFingerprint: jibriJwtSecretFingerprint(env.JITSI_JWT_SECRET?.trim() ?? ""),
  };
}

/**
 * What the APP expects the worker's identity to be, from the app's own
 * environment (the same defaults as the worker's). Null with a reason when
 * the app's own Jitsi settings are incomplete: then no worker can be
 * verified (it is never healthy).
 */
export function expectedJibriWorkerIdentity(env: NodeJS.ProcessEnv = process.env):
  | { identity: JibriWorkerIdentity; reason: null }
  | { identity: null; reason: string } {
  const target = resolveJibriStopTarget(env);

  if (!target.enabled) return { identity: null, reason: target.reason };

  return { identity: jibriWorkerIdentity(target.config, env), reason: null };
}

/** The fields in which the worker's reported identity differs from the expected one (missing counts as different). */
export function diffJibriWorkerIdentity(
  expected: JibriWorkerIdentity,
  reported: Partial<Record<JibriIdentityField, string | null | undefined>>
): JibriIdentityField[] {
  return JIBRI_IDENTITY_FIELDS.filter(field => reported[field] !== expected[field]);
}
