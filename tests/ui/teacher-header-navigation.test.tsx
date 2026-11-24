/**
 * Teacher panel navigation reorganization:
 *  - sidebar order: Overview, Calendar, Students, Classes, Notes, Assignments
 *    (Assignments, Quizzes), Recordings (Recorded Lectures, YouTube Live
 *    Sessions, Live Recordings), then the rest in their previous order;
 *    Teacher Profile and Messages are no longer sidebar items;
 *  - Messages: an icon beside the notification bell (teachers), linking to the
 *    existing /dashboard/messages page; locked for a pending teacher;
 *  - Teacher Profile: a link in the existing profile menu (name / avatar),
 *    next to Change password and Sign out.
 * The pages themselves are unchanged. No DOM library: react-dom/server
 * renders and source checks (the profile menu opens on click).
 *
 *   npm run test:ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { DashboardShell, MESSAGES_HREF, TEACHER_PROFILE_HREF } from "../../components/dashboard-shell";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

const router: AppRouterInstance = { back: () => {}, forward: () => {}, refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {} };
function shell(pathname: string, options: { role?: "TEACHER" | "ADMIN"; isPending?: boolean } = {}) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value={pathname}>
        <DashboardShell role={options.role ?? "TEACHER"} name="Nimal Perera" email="t@example.com" isPending={options.isPending ?? false}>
          <p>content</p>
        </DashboardShell>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}
const nav = (html: string) => html.slice(html.indexOf("<nav"), html.indexOf("</nav>"));
const header = (html: string) => html.slice(html.indexOf("<header"), html.indexOf("</header>"));
/** The top-level sidebar entries, in order (links, locked items and group buttons all carry a title). */
const sidebarLabels = (html: string) => [...nav(html).matchAll(/<(?:a|button|div)[^>]*\btitle="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

const ORDER = [
  "Overview",
  "Calendar",
  "Students",
  "Classes",
  "Notes",
  "Assignments",
  "Recordings",
  "Payments",
  "Lectures",
  "Attendance",
  "Tutes & Papers",
  "Papers",
  "Paper Config",
  "Live Sessions",
];

test("sidebar: the new main order, then the remaining items in their previous order; no Teacher Profile or Messages", () => {
  assert.deepEqual(sidebarLabels(shell("/dashboard")), ORDER);
  const html = nav(shell("/dashboard"));
  assert.doesNotMatch(html, /href="\/dashboard\/messages"|href="\/dashboard\/teacher\/profile"|title="Teacher Profile"|title="Messages"/);
  // The groups keep their pages (source: the collapsed render shows only the group buttons).
  const src = source("components", "dashboard-shell.tsx");
  const at = (href: string) => src.indexOf(`href: "${href}"`);
  assert.ok(at("/dashboard/notes") < at("/dashboard/assignments") && at("/dashboard/assignments") < at("/dashboard/quizzes"));
  assert.ok(at("/dashboard/quizzes") < at("/dashboard/recordings") && at("/dashboard/recordings") < at("/dashboard/recordings/recorded-lectures"));
  assert.ok(at("/dashboard/recordings/live-recordings") < at("/dashboard/payments"));
  assert.doesNotMatch(src, /\{ href: "\/dashboard\/(messages|teacher\/profile)",\s+label:/, "not sidebar items any more");
});

test("sidebar: a pending teacher still sees every item locked except Overview, in the same order", () => {
  const html = shell("/dashboard", { isPending: true });
  assert.deepEqual(sidebarLabels(html), ORDER);
  assert.doesNotMatch(nav(html), /href="\/dashboard\/(?!")/, "only Overview links");
  assert.match(nav(html), /href="\/dashboard"/);
});

test("sidebar: the active item and the groups still highlight on their pages", () => {
  const active = (pathname: string) => [...nav(shell(pathname)).matchAll(/<(?:a|button)[^>]*\btitle="([^"]+)"[^>]*class="[^"]*bg-white\/15/g)].map((m) => m[1]);
  assert.deepEqual(active("/dashboard/notes"), ["Notes"]);
  assert.deepEqual(active("/dashboard/quizzes"), ["Assignments"]);
  assert.deepEqual(active("/dashboard/recordings/live-recordings"), ["Recordings"]);
  assert.deepEqual(active("/dashboard/classes"), ["Classes"]);
  assert.deepEqual(active("/dashboard/messages"), [], "Messages is in the header now");
});

test("header: a Messages icon right after the notification bell, linking to the existing Messages page (no unread badge: teachers' messages are outgoing)", () => {
  assert.equal(MESSAGES_HREF, "/dashboard/messages");
  const html = header(shell("/dashboard"));
  const bell = html.indexOf('aria-label="Notifications"');
  const messages = html.indexOf('aria-label="Messages"');
  const profile = html.indexOf("Nimal Perera");
  assert.ok(bell > 0 && messages > bell && profile > messages, "bell, Messages, then the profile button");
  assert.match(html, /<a aria-label="Messages" title="Messages" class="[^"]*text-slate-500[^"]*" data-header-messages="true" href="\/dashboard\/messages">/);
  assert.doesNotMatch(html.slice(messages, profile), /rounded-full bg-rose-500|9\+/, "no invented unread badge");
  // The notification bell is unchanged.
  assert.match(html, /aria-label="Notifications"[^>]*>.*?<span class="absolute right-2 top-2 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-white"><\/span><\/button>/);
  // Shown at every width (no responsive hiding).
  assert.doesNotMatch(html.slice(messages - 400, messages), /\bhidden\b sm:/);
});

test("header: Messages is marked current on the Messages page; locked for a pending teacher; not shown to admins", () => {
  assert.match(header(shell("/dashboard/messages")), /<a aria-label="Messages" title="Messages" aria-current="page" class="[^"]*bg-brand-50 text-brand-700[^"]*" data-header-messages="true" href="\/dashboard\/messages">/);
  const pending = header(shell("/dashboard", { isPending: true }));
  assert.doesNotMatch(pending, /href="\/dashboard\/messages"/);
  assert.match(pending, /<span role="link" aria-disabled="true" aria-label="Messages \(available after your account is approved\)"[^>]*data-header-messages="locked"/);
  const admin = shell("/dashboard/admin", { role: "ADMIN" });
  assert.doesNotMatch(header(admin), /aria-label="Messages/);
  assert.deepEqual(sidebarLabels(admin), ["Admin Overview", "Teachers", "Packages"], "the admin sidebar is unchanged");
});

test("profile menu: the existing name / email / role, Teacher profile (teachers), Change password and Sign out; one menu, no duplicate", () => {
  assert.equal(TEACHER_PROFILE_HREF, "/dashboard/teacher/profile");
  const src = source("components", "dashboard-shell.tsx");
  const menu = src.slice(src.indexOf("{isProfileOpen && ("), src.indexOf("</header>"));
  assert.match(menu, /\{displayName \?\? name\}/);
  assert.match(menu, /\{email\}/);
  assert.match(menu, /\{role\}/);
  const profileLink = menu.indexOf("href={TEACHER_PROFILE_HREF}");
  const password = menu.indexOf('href="/account/security"');
  const signOut = menu.indexOf("onClick={handleSignOut}");
  assert.ok(profileLink > 0 && profileLink < password && password < signOut, "Teacher profile, Change password, Sign out");
  assert.match(menu, /role === "TEACHER" \? \(\s*isPending \? \(\s*<span aria-disabled="true"[^>]*data-profile-menu-teacher-profile="locked"/, "locked for a pending teacher, as in the sidebar before");
  assert.equal((src.match(/\{isProfileOpen && \(/g) ?? []).length, 1, "a single profile menu");
  // The profile button still opens it (name and avatar).
  assert.match(header(shell("/dashboard")), /<button type="button" class="inline-flex items-center gap-2\.5 rounded-xl[^"]*"><span[^>]*>NP<\/span><span class="hidden sm:block max-w-\[160px\] truncate">Nimal Perera<\/span>/);
});

test("the pages behind the moved links are unchanged and still routed", () => {
  for (const parts of [["app", "dashboard", "messages", "page.tsx"], ["app", "dashboard", "teacher", "profile", "page.tsx"]]) {
    assert.ok(existsSync(path.join(ROOT, ...parts)), parts.join("/"));
  }
});
