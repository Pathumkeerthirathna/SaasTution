/**
 * Course Sessions card (components/teacherProfile/classLanding/ClassSessionsPreview.tsx):
 * the public class page's card is unchanged by default; the payment-restricted
 * student's dashboard passes its own description and hides the
 * "Unlock Full Course / Register" footer.
 *
 *   npm run test:ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import ClassSessionsPreview from "../../components/teacherProfile/classLanding/ClassSessionsPreview";
import type { ClassLectureSession } from "../../types/teacherProfileTypes/ClassLectureSession";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const lectures: ClassLectureSession[] = [
  {
    id: "l1",
    title: "Lesson 1",
    date: "2026-11-01T00:00:00.000Z",
    createdAt: "2026-11-01T00:00:00.000Z",
    recordings: [{ id: "y1", access: "FREE", videoId: "abc", youtubeUrl: "https://www.youtube.com/watch?v=abc", startedAt: null, endedAt: null }],
    uploads: [{ source: "UPLOAD", id: "u1", title: "Part 1", partNumber: 1, durationSeconds: 60, access: "FREE", streamUrl: "/api/public/recorded-lectures/u1/stream" }],
  },
];

test("public class page (defaults): heading, description and the Register footer as before", () => {
  const t = text(renderToStaticMarkup(<ClassSessionsPreview lectures={lectures} />));
  assert.match(t, /Course Sessions/);
  assert.match(t, /Recorded lectures published for this class\./);
  assert.match(t, /Unlock Full Course/);
  assert.match(t, /Register to unlock every locked recording/);
});

test("restricted student dashboard: own description, no Register footer, the free recordings stay watchable", () => {
  const t = text(
    renderToStaticMarkup(
      <ClassSessionsPreview lectures={lectures} description="Free recordings your teacher published for everyone." showRegisterFooter={false} />
    )
  );
  assert.match(t, /Course Sessions/);
  assert.match(t, /Free recordings your teacher published for everyone\./);
  assert.doesNotMatch(t, /Recorded lectures published for this class/);
  assert.doesNotMatch(t, /Unlock Full Course|Register to unlock/);
  assert.match(t, /2 Free/);
  assert.equal((t.match(/Watch/g) ?? []).length >= 2, true, "both free recordings have a Watch button");
});
