import path from "node:path";

import { AppError } from "@/lib/error-handler";

/*
 * Automated-test safety for outgoing email (used by lib/mailer.ts).
 *
 * Environment variables are not a reliable switch inside tests: importing the
 * generated Prisma Client loads the project .env and fills in every variable
 * that is currently absent, so a test that deletes SENDER_API_TOKEN gets the
 * real token back as soon as any module imports @prisma/client. This guard
 * therefore never trusts the provider variables in a test process:
 *
 *  - Sender.net (a real external API) is never selected, unless the test has
 *    registered an in-process fake for its HTTP calls (useTestSenderFetch).
 *    Even then the request goes to that fake, never to the global fetch.
 *  - SMTP is allowed only to hosts that cannot be a real mail server:
 *    loopback, or the reserved test domains (.test, .example, .invalid,
 *    .localhost; RFC 2606 / RFC 6761). Anything else fails with
 *    EMAIL_BLOCKED_IN_TEST before a connection is opened.
 *
 * Outside automated tests nothing here changes behaviour.
 */

/**
 * An automated test run: NODE_ENV=test, any process started by the node:test
 * runner (`node --test`, `tsx --test` set NODE_TEST_CONTEXT in every test
 * process), or a test file run directly (`node some.test.cjs`). None of these
 * is ever true under `next dev` / `next start`.
 */
export function isAutomatedTestRun(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv
): boolean {
  return (
    env.NODE_ENV === "test" ||
    Boolean(env.NODE_TEST_CONTEXT) ||
    /\.test\.[cm]?[jt]sx?$/.test(path.basename(argv[1] ?? ""))
  );
}

const TEST_SAFE_SMTP_HOST =
  /^(?:localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$|\.(?:test|example|invalid|localhost)$/i;

/** Hosts that can never reach a real mail server (loopback or reserved test domains). */
export function isTestSafeSmtpHost(host: string | undefined | null): boolean {
  return Boolean(host) && TEST_SAFE_SMTP_HOST.test(String(host).trim());
}

export function emailBlockedInTestError(detail: string) {
  return new AppError(
    `Real email delivery is blocked during automated tests (${detail}).`,
    500,
    "EMAIL_BLOCKED_IN_TEST"
  );
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let testSenderFetch: FetchLike | null = null;

/**
 * Tests only: routes Sender.net API requests to an in-process fake (pass null
 * to remove it). Registered in code, never through the environment, so a
 * value loaded from .env can never enable it. Ignored outside automated tests.
 */
export function useTestSenderFetch(fake: FetchLike | null) {
  testSenderFetch = fake;
}

/** Whether the Sender.net provider may be selected in this process. */
export function senderProviderAllowed(): boolean {
  return !isAutomatedTestRun() || testSenderFetch !== null;
}

/**
 * The fetch used for Sender.net requests: the platform fetch normally; in an
 * automated test only the registered fake. Throws EMAIL_BLOCKED_IN_TEST (no
 * network request) when a test reaches Sender.net without a fake.
 */
export function senderFetch(): FetchLike {
  if (!isAutomatedTestRun()) return fetch;
  if (!testSenderFetch) throw emailBlockedInTestError("Sender.net API without a test fake");
  return testSenderFetch;
}

/** Throws EMAIL_BLOCKED_IN_TEST when a test would open SMTP to a real host. */
export function assertSmtpHostAllowed(host: string | undefined) {
  if (isAutomatedTestRun() && host && !isTestSafeSmtpHost(host)) {
    throw emailBlockedInTestError("SMTP host is not a local test server");
  }
}
