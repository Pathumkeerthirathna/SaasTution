/**
 * End Session with Group Activities (components/session-end/group-end-decision.tsx,
 * JitsiClassroom.tsx, lecture-management-panel.tsx).
 *
 * The request flow runs against a fake fetch; the dialog markup is rendered
 * with react-dom/server; the wiring of both End Session entry points is
 * checked from source. Clicking through the real dialog in a browser remains
 * a manual check.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  endSessionWithGroupDecision,
  GroupEndDecisionDialog,
  type GroupEndSummary,
} from "../../components/session-end/group-end-decision";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

const SUMMARY: GroupEndSummary = { assignments: 2, quizzes: 1, rooms: 2, submittedAssignments: 1, submittedQuizzes: 0 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function withFetch(responses: Response[]) {
  const sent: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  }) as typeof fetch;
  return { sent, restore: () => (globalThis.fetch = original) };
}

const ENDED = { success: true, data: { sessionId: "s1", alreadyEnded: false, youtubeCleanup: { status: "none" } } };
const DECISION_REQUIRED = {
  success: false,
  error: { code: "GROUP_ACTIVITIES_DECISION_REQUIRED", message: "Choose", details: { summary: SUMMARY } },
};

test("no GROUP activities: one POST without a body, no dialog (as before)", async () => {
  const f = withFetch([json(200, ENDED)]);
  try {
    let asked = false;
    const result = await endSessionWithGroupDecision("s1", async () => {
      asked = true;
      return "preserve";
    });
    assert.equal(asked, false);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].url, "/api/sessions/s1/end");
    assert.equal(f.sent[0].init?.method, "POST");
    assert.equal(f.sent[0].init?.body, undefined);
    assert.equal(result?.data.success, true);
  } finally {
    f.restore();
  }
});

test("GROUP activities: the dialog gets the summary; the POST is repeated with the choice", async () => {
  for (const decision of ["preserve", "delete"] as const) {
    const f = withFetch([json(409, DECISION_REQUIRED), json(200, { ...ENDED, data: { ...ENDED.data, groupActivities: { decision } } })]);
    try {
      let seen: GroupEndSummary | null = null;
      const result = await endSessionWithGroupDecision("s1", async (summary) => {
        seen = summary;
        return decision;
      });
      assert.deepEqual(seen, SUMMARY);
      assert.equal(f.sent.length, 2);
      assert.equal(f.sent[1].init?.body, JSON.stringify({ groupActivities: decision }));
      assert.equal(result?.data.data?.groupActivities?.decision, decision);
    } finally {
      f.restore();
    }
  }
});

test("Cancel in the dialog: nothing more is sent and the session keeps running (null)", async () => {
  const f = withFetch([json(409, DECISION_REQUIRED)]);
  try {
    const result = await endSessionWithGroupDecision("s1", async () => null);
    assert.equal(result, null);
    assert.equal(f.sent.length, 1);
  } finally {
    f.restore();
  }
});

test("any other error is returned to the caller unchanged (shown as before)", async () => {
  const f = withFetch([json(404, { success: false, error: { code: "SESSION_NOT_FOUND", message: "Session not found." } })]);
  try {
    const result = await endSessionWithGroupDecision("s1", async () => "delete");
    assert.equal(result?.response.status, 404);
    assert.equal(f.sent.length, 1);
  } finally {
    f.restore();
  }
});

test("dialog: counts, keep, delete (a second, explicit step) and cancel; individual activities unaffected", () => {
  const html = renderToStaticMarkup(<GroupEndDecisionDialog summary={SUMMARY} onChoose={() => {}} />);
  assert.match(html, /2 group assignments and 1 group quiz in 2 breakout rooms/);
  assert.match(html, /1 submitted assignment, 0 submitted quizzes/);
  assert.match(html, /Keep group activities/);
  assert.match(html, /Delete group activities/);
  assert.match(html, /Cancel/);
  assert.match(html, /Individual activities are not affected/);
  assert.doesNotMatch(html, /Delete and end session/, "deleting needs a second click");
  assert.match(html, /role="dialog"/);
});

test("both End Session entry points go through the decision flow and render the dialog", () => {
  for (const file of [["components", "Jitsi", "JitsiClassroom.tsx"], ["components", "lecture-management-panel.tsx"]]) {
    const text = source(...file);
    assert.match(text, /endSessionWithGroupDecision\(/, file.join("/"));
    assert.match(text, /useGroupEndDecision\(\)/, file.join("/"));
    assert.match(text, /\{groupEndDecision\.dialog\}/, file.join("/"));
    assert.match(text, /showGroupCleanupWarning\(/, file.join("/"));
    assert.doesNotMatch(text, /fetch\(`\/api\/sessions\/\$\{[^}]+\}\/end`/, `${file.join("/")}: no direct End Session POST left`);
    assert.match(text, /if \(!ended\) return;/, `${file.join("/")}: Cancel keeps the session`);
  }
});
