/**
 * Student Profile SP-4: the display-only "My Attendance QR" on /student/profile
 * (components/student-portal/student-qr-panel.tsx over the shared
 * components/qr/qr-identity-card.tsx), the Settings page pointer, and the
 * teacher card left as it was. Views render with react-dom/server; the
 * fetch / download path is checked against the card's source (no DOM library
 * in the project). The QR API itself is covered, unchanged, by
 * tests/student-qr/*.
 *
 *   npm run test:ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { QrIdentityCard } from "../../components/qr/qr-identity-card";
import {
  QR_ENLARGE_DESCRIPTION_ID,
  QR_ENLARGE_TITLE_ID,
  QrEnlargeDialogView,
  isBackdropClick,
  lockBodyScroll,
  qrDialogKeyAction,
} from "../../components/qr/qr-enlarge-dialog";
import { STUDENT_QR_ENDPOINTS, StudentQrPanel } from "../../components/student-portal/student-qr-panel";
import { STUDENT_QR_PANEL_ID, studentNavItems } from "../../components/student-portal/student-data";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const code = (...parts: string[]) => source(...parts).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]).trim());

const REGENERATION = /Regenerat|regenerations?\s+left|alertdialog|student-qr-quota|Print QR/i;

test("profile: 'My Attendance QR' is part of /student/profile, for the student the profile API returned", () => {
  const profile = code("components", "student-portal", "student-profile.tsx");
  const panel = profile.slice(profile.indexOf("export function StudentProfilePanel"));
  assert.match(panel, /<StudentQrPanel studentName=\{profile\.name\} registrationNumber=\{profile\.registrationNumber\} \/>/);
  assert.equal((profile.match(/<StudentQrPanel\b/g) ?? []).length, 1);
  assert.match(source("app", "student", "profile", "page.tsx"), /<StudentProfilePanel \/>/);
});

test("panel: titled 'My Attendance QR' with the attendance explanation, the QR area, Download QR Code and Enlarge QR Code", () => {
  const html = renderToStaticMarkup(<StudentQrPanel studentName="Amal Perera" registrationNumber="STU-0042" />);
  const t = text(html);
  assert.match(html, new RegExp(`<section id="${STUDENT_QR_PANEL_ID}"`));
  assert.equal(STUDENT_QR_PANEL_ID, "my-attendance-qr");
  assert.match(html, /<h2[^>]*>My Attendance QR<\/h2>/);
  assert.ok(t.includes("Show this QR code to your teacher to mark your attendance."));
  assert.ok(t.includes("Loading QR code…"), "loading state first");
  assert.match(html, /role="status"/);
  assert.ok(t.includes("Amal Perera") && t.includes("Registration No: STU-0042"));
  assert.deepEqual(buttons(html), ["Download QR Code", "Enlarge QR Code"], "view, download and enlarge only");
  assert.match(html, /<button type="button" disabled=""[^>]*>[\s\S]*?Download QR Code<\/button>/, "disabled until the image has loaded");
  assert.doesNotMatch(html, REGENERATION, "no regenerate button, dialog, counts or print");
  assert.ok(t.includes("ask your teacher for a new one"));
});

test("panel: uses the existing authenticated /api/students/me/qr endpoints and passes no regenerate endpoint", () => {
  assert.deepEqual({ ...STUDENT_QR_ENDPOINTS }, {
    status: "/api/students/me/qr/status",
    issue: "/api/students/me/qr/issue",
    image: "/api/students/me/qr",
  });
  assert.ok(!("regenerate" in STUDENT_QR_ENDPOINTS));
  for (const route of ["app/api/students/me/qr/route.ts", "app/api/students/me/qr/status/route.ts", "app/api/students/me/qr/issue/route.ts"]) {
    const routeCode = source(...route.split("/"));
    assert.match(routeCode, /requireStudentSession\(\)/, `${route}: the student comes from the session`);
    assert.match(routeCode, /withNoStore\(/, `${route}: no-store`);
  }
  assert.doesNotMatch(source("components", "student-portal", "student-qr-panel.tsx"), /\/regenerate|studentId/);
});

test("card: a student card stays display-only even if a regenerate endpoint were passed", () => {
  const html = renderToStaticMarkup(
    <QrIdentityCard variant="student" endpoints={{ ...STUDENT_QR_ENDPOINTS, regenerate: "/api/students/me/qr/regenerate" }} studentName="A" registrationNumber={null} />
  );
  assert.deepEqual(buttons(html), ["Download QR Code"]);
  assert.doesNotMatch(html, REGENERATION);
});

test("card: the teacher's card is unchanged (Download, Print, Regenerate and its footnote)", () => {
  const base = "/api/students/s-1/qr";
  const html = renderToStaticMarkup(
    <QrIdentityCard variant="teacher" endpoints={{ status: `${base}/status`, issue: `${base}/issue`, image: base, regenerate: `${base}/regenerate` }} studentName="A" registrationNumber="R-1" />
  );
  assert.deepEqual(buttons(html), ["Download QR", "Print QR", "Regenerate QR"]);
  assert.ok(text(html).includes("Regenerate only if the student's QR code was lost or shared."));
  assert.match(source("app", "student", "Components", "StudentQrIdentity.tsx"), /regenerate: `\$\{base\}\/regenerate`/);
});

test("card: the image loads from the PNG endpoint (no-store, same-origin) into an in-memory blob URL; Download saves that blob", () => {
  const card = code("components", "qr", "qr-identity-card.tsx");
  assert.match(card, /fetch\(endpoints\.image, \{ cache: "no-store", credentials: "same-origin" \}\)/);
  assert.match(card, /content-type"\)\?\.startsWith\("image\/png"\)/, "only a PNG is shown");
  assert.match(card, /replaceImage\(await response\.blob\(\)\)/);
  assert.match(card, /URL\.createObjectURL\(blob\)/);
  assert.match(card, /<img\s+src=\{imageUrl\}/);
  const download = card.slice(card.indexOf("const handleDownload"), card.indexOf("const handlePrint"));
  assert.match(download, /link\.href = imageUrlRef\.current;/, "the already-loaded PNG, no second request and no token in a URL");
  assert.match(download, /"my-qr-code\.png"/);
  assert.match(card, /onClick=\{handleDownload\}/);
});

test("card: regeneration is unreachable without a regenerate endpoint (button, dialog, counts and the request itself)", () => {
  const card = code("components", "qr", "qr-identity-card.tsx");
  assert.match(card, /const canRegenerate = Boolean\(regenerateEndpoint && regenCopy\);/);
  assert.match(card, /if \(!regenerateEndpoint \|\| !regenCopy\) return;/);
  assert.match(card, /\{canRegenerate && \(\s*<>\s*<button type="button" onClick=\{handlePrint\}/);
  assert.match(card, /\{canRegenerate && regenCopy && confirming && \(/);
  assert.match(card, /\{canRegenerate && regenCopy && status && status\.configured && \(/);
  assert.doesNotMatch(card.slice(card.indexOf("const REGENERATION_COPY"), card.indexOf("const SESSION_EXPIRED")), /student:/, "no regeneration wording for students");
});

test("no raw QR token: the client reads only status fields and a PNG; nothing stored or logged", () => {
  for (const file of ["components/qr/qr-identity-card.tsx", "components/student-portal/student-qr-panel.tsx", "components/student-portal/student-profile.tsx"]) {
    const c = code(...file.split("/"));
    // ("hasActiveToken" / "QR_TOKEN_NOT_FOUND" are status flags and an error code, not token material.)
    assert.doesNotMatch(c, /\btoken\b|qr\.payload|\.token\b|student-qr-service|student-qr-token/i, file);
    assert.doesNotMatch(c, /localStorage|sessionStorage|indexedDB|console\./, file);
  }
  const html = renderToStaticMarkup(<StudentQrPanel studentName="Amal" registrationNumber="STU-1" />);
  assert.doesNotMatch(html, /token|\/api\/students\/me\/qr/i, "no token and no endpoint URL in the markup");
  const status = code("lib", "student-qr-http.ts");
  const publicStatus = status.slice(status.indexOf("export function toPublicQrStatus"), status.indexOf("export function withNoStore"));
  assert.doesNotMatch(publicStatus, /token:|payload|secret/, "the status JSON has no token material");
});

test("settings: password management unchanged; the QR is a link to My Profile (one QR card, no duplicate state)", () => {
  const settings = source("app", "student", "settings", "page.tsx");
  assert.match(settings, /href="\/account\/security"/);
  assert.match(settings, /Open Security Settings/);
  assert.match(settings, /Password and account security/);
  assert.match(settings, /href=\{`\/student\/profile#\$\{STUDENT_QR_PANEL_ID\}`\}/);
  assert.match(settings, /from "@\/components\/student-portal\/student-data"/, "the id comes from a plain module (server page)");
  assert.doesNotMatch(settings, /StudentQrPanel|QrIdentityCard|\/api\/students\/me\/qr/);
  assert.doesNotMatch(source("components", "student-portal", "student-data.ts"), /use client/);

  // Exactly one student-facing QR card in the app.
  const uses = ["components/student-portal/student-profile.tsx", "app/student/settings/page.tsx", "app/student/profile/page.tsx"].filter((f) =>
    /<StudentQrPanel\b|variant="student"/.test(source(...f.split("/")))
  );
  assert.deepEqual(uses, ["components/student-portal/student-profile.tsx"]);

  const hrefs = studentNavItems.map((item) => item.href);
  assert.ok(hrefs.includes("/student/profile") && hrefs.includes("/student/settings"));
  assert.match(source("components", "student-portal", "student-profile.tsx"), /href="\/student\/settings"/);
});

test("the QR API, services and the teacher's QR routes are still there (not removed or changed by this stage)", () => {
  for (const file of [
    "app/api/students/me/qr/regenerate/route.ts",
    "app/api/students/[id]/qr/route.ts",
    "app/api/students/[id]/qr/regenerate/route.ts",
    "services/student-qr-service.ts",
  ]) assert.ok(existsSync(path.join(ROOT, file)), file);
});

// ---- Enlarge QR Code (student side only) ------------------------------------------------------

const BLOB_URL = "blob:http://localhost/0b6f5d1e-qr";

test("enlarge: the student panel offers Enlarge QR Code next to Download, disabled until the QR has loaded; no dialog until opened", () => {
  const html = renderToStaticMarkup(<StudentQrPanel studentName="Amal Perera" registrationNumber="STU-0042" />);
  const enlarge = /<button([^>]*)>(?:(?!<\/button>)[\s\S])*Enlarge QR Code<\/button>/.exec(html.slice(html.indexOf("Download QR Code")));
  assert.ok(enlarge, "Enlarge QR Code button");
  assert.match(enlarge[1], /type="button"/);
  assert.match(enlarge[1], /disabled=""/, "disabled while loading");
  assert.match(enlarge[1], /aria-haspopup="dialog"/);
  assert.ok(html.indexOf("Download QR Code") < html.indexOf("Enlarge QR Code"), "Download stays first");
  assert.doesNotMatch(html, /role="dialog"|aria-modal/, "closed by default");
  assert.doesNotMatch(html, REGENERATION);
});

test("enlarge: opt-in only — the teacher card and a student card without the prop render no Enlarge action", () => {
  const base = "/api/students/s-1/qr";
  const teacher = renderToStaticMarkup(
    <QrIdentityCard variant="teacher" endpoints={{ status: `${base}/status`, issue: `${base}/issue`, image: base, regenerate: `${base}/regenerate` }} studentName="A" registrationNumber="R-1" />
  );
  assert.deepEqual(buttons(teacher), ["Download QR", "Print QR", "Regenerate QR"]);
  assert.doesNotMatch(teacher, /Enlarge|aria-haspopup|role="dialog"/);
  const plain = renderToStaticMarkup(<QrIdentityCard variant="student" endpoints={STUDENT_QR_ENDPOINTS} studentName="A" registrationNumber={null} />);
  assert.deepEqual(buttons(plain), ["Download QR Code"]);
  assert.doesNotMatch(source("app", "student", "Components", "StudentQrIdentity.tsx"), /enlargeable/, "teacher page does not opt in");
  assert.match(code("components", "student-portal", "student-qr-panel.tsx"), /<QrIdentityCard[\s\S]*?\benlargeable\b[\s\S]*?\/>/);
});

test("enlarge: the dialog is a titled, described modal with a Close button, showing the same QR image URL, sharp and large", () => {
  const html = renderToStaticMarkup(
    <QrEnlargeDialogView imageUrl={BLOB_URL} studentName="Amal Perera" registrationNumber="STU-0042" onClose={() => undefined} />
  );
  const dialog = /<div([^>]*role="dialog"[^>]*)>/.exec(html);
  assert.ok(dialog, "role=dialog");
  assert.match(dialog[1], /aria-modal="true"/);
  assert.match(dialog[1], new RegExp(`aria-labelledby="${QR_ENLARGE_TITLE_ID}"`));
  assert.match(dialog[1], new RegExp(`aria-describedby="${QR_ENLARGE_DESCRIPTION_ID}"`));
  assert.match(html, new RegExp(`<h2 id="${QR_ENLARGE_TITLE_ID}"[^>]*>My Attendance QR</h2>`));
  const description = html.slice(html.indexOf(`id="${QR_ENLARGE_DESCRIPTION_ID}"`));
  assert.ok(text(description).includes("Amal Perera") && text(description).includes("Registration No: STU-0042"));

  const image = /<img([^>]*)>/.exec(html);
  assert.ok(image);
  assert.match(image[1], new RegExp(`src="${BLOB_URL}"`), "the card's existing blob URL, no new QR");
  assert.match(image[1], /alt="QR code for Amal Perera"/);
  assert.match(image[1], /\[image-rendering:pixelated\]/, "no smoothing when scaled up");
  assert.match(image[1], /w-\[min\(85vw,70vh,560px\)\]/, "large but always fits the screen");
  assert.match(image[1], /max-w-full/);

  const close = /<button([^>]*)>/.exec(html);
  assert.ok(close);
  assert.match(close[1], /type="button"/);
  assert.match(close[1], /aria-label="Close enlarged QR code"/);
  assert.equal([...html.matchAll(/<button\b/g)].length, 1, "Close is the only control");
  assert.match(html, /class="fixed inset-0[^"]*overflow-y-auto[^"]*p-4"/, "full-screen backdrop with a gutter, scrollable on small screens");

  const noNumber = renderToStaticMarkup(<QrEnlargeDialogView imageUrl={BLOB_URL} studentName="A" registrationNumber={null} onClose={() => undefined} />);
  assert.ok(text(noNumber).includes("Registration number not assigned yet"));
});

test("enlarge: Escape closes, Tab keeps focus on Close, other keys do nothing; only a click on the backdrop itself closes", () => {
  assert.equal(qrDialogKeyAction("Escape"), "close");
  assert.equal(qrDialogKeyAction("Esc"), "close");
  assert.equal(qrDialogKeyAction("Tab"), "trap-focus");
  assert.equal(qrDialogKeyAction("Enter"), null);
  assert.equal(qrDialogKeyAction(" "), null);

  const backdrop = {} as EventTarget;
  const panel = {} as EventTarget;
  assert.equal(isBackdropClick(backdrop, backdrop), true);
  assert.equal(isBackdropClick(panel, backdrop), false, "a click inside the dialog never closes it");
  assert.equal(isBackdropClick(null, backdrop), false);

  const dialog = code("components", "qr", "qr-enlarge-dialog.tsx");
  assert.match(dialog, /onClick=\{onBackdropClick\}/);
  assert.match(dialog, /if \(isBackdropClick\(event\.target, event\.currentTarget\)\) onClose\(\);/);
  assert.match(dialog, /<button\s+ref=\{closeButtonRef\}\s+type="button"\s+onClick=\{onClose\}/);
});

test("enlarge: background scrolling is locked while open and the previous inline styles are restored on close", () => {
  const body = { style: { overflow: "scroll", paddingRight: "3px" } };
  const unlock = lockBodyScroll(body, 15);
  assert.deepEqual(body.style, { overflow: "hidden", paddingRight: "15px" }, "no layout shift when the scrollbar goes");
  unlock();
  assert.deepEqual(body.style, { overflow: "scroll", paddingRight: "3px" });

  const plain = { style: { overflow: "", paddingRight: "" } };
  const restore = lockBodyScroll(plain, 0);
  assert.deepEqual(plain.style, { overflow: "hidden", paddingRight: "" }, "no padding without a scrollbar (mobile)");
  restore();
  assert.deepEqual(plain.style, { overflow: "", paddingRight: "" });
});

test("enlarge: the open dialog focuses Close, listens for keys, and on close unlocks scrolling, removes the listener and restores focus", () => {
  const dialog = code("components", "qr", "qr-enlarge-dialog.tsx");
  const effect = dialog.slice(dialog.indexOf("useEffect(() => {"), dialog.indexOf("return createPortal"));
  assert.match(effect, /const opener = document\.activeElement/);
  assert.match(effect, /const unlock = lockBodyScroll\(document\.body,/);
  assert.match(effect, /closeButtonRef\.current\?\.focus\(\);/);
  assert.match(effect, /document\.addEventListener\("keydown", onKeyDown\);/);
  const cleanup = effect.slice(effect.lastIndexOf("return () => {"));
  assert.match(cleanup, /document\.removeEventListener\("keydown", onKeyDown\);/);
  assert.match(cleanup, /unlock\(\);/);
  assert.match(cleanup, /opener\.focus\(\)/);
  assert.match(dialog, /createPortal\(<QrEnlargeDialogView \{\.\.\.props\} closeButtonRef=\{closeButtonRef\} \/>, document\.body\)/, "rendered above every layout container");
});

test("enlarge: reuses the loaded image only — no new request, QR, storage or download change; closes if the image goes away", () => {
  const dialog = code("components", "qr", "qr-enlarge-dialog.tsx");
  assert.doesNotMatch(dialog, /fetch\(|createObjectURL|revokeObjectURL|localStorage|sessionStorage|\/api\/|\btoken\b|console\./);

  const card = code("components", "qr", "qr-identity-card.tsx");
  assert.equal((card.match(/\bfetch\(/g) ?? []).length, 4, "status, image, issue, regenerate: no request added");
  assert.match(card, /const canEnlarge = enlargeable && canAct;/);
  assert.match(card, /\{enlarged && canEnlarge && imageUrl && \(\s*<QrEnlargeDialog\s+imageUrl=\{imageUrl\}/, "the card's own blob URL; unmounted once the image is gone");
  assert.match(card, /\{enlargeable && \(\s*<button\s+type="button"\s+onClick=\{\(\) => setEnlarged\(true\)\}\s+disabled=\{!canEnlarge\}/);
  assert.match(card, /canEnlarge \? \(\s*<button[\s\S]*?aria-label="Enlarge QR code"[\s\S]*?\{qrImage\}\s*<\/button>\s*\) : \(\s*qrImage\s*\)/, "the QR itself opens it");
  const download = card.slice(card.indexOf("const handleDownload"), card.indexOf("const handlePrint"));
  assert.doesNotMatch(download, /enlarg/i, "Download unchanged");
});
