/**
 * The teacher sidebar's Attendance item (Stage 5.5d-5c):
 * components/dashboard-shell.tsx. The real shell renders with
 * react-dom/server inside Next's pathname and app-router contexts, so the
 * active state comes from the shell's own matching for each path. Clicking
 * is covered by the rendered link's href (next/link navigates to it);
 * clicking through the real app remains a manual check.
 *
 *   npm run test:attendance-ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { DashboardShell, isNavItemActive } from "../../components/dashboard-shell";

const router: AppRouterInstance = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
};

function shell(pathname: string, options: { role?: "TEACHER" | "ADMIN"; isPending?: boolean } = {}) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value={pathname}>
        <DashboardShell role={options.role ?? "TEACHER"} name="Teacher" email="t@example.com" isPending={options.isPending}>
          <p>content</p>
        </DashboardShell>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

/** The sidebar's top-level links: label → { href, active }. */
function sidebarLinks(html: string) {
  const nav = html.slice(html.indexOf("<nav"), html.indexOf("</nav>"));
  const links = new Map<string, { href: string; active: boolean }>();
  for (const tag of nav.match(/<a [^>]*>/g) ?? []) {
    const label = /aria-label="([^"]+)"/.exec(tag)?.[1];
    const href = /href="([^"]+)"/.exec(tag)?.[1];
    if (!label || !href) continue; // group children have no aria-label
    links.set(label, { href, active: /class="[^"]*\bbg-white\/15\b/.test(tag) });
  }
  return links;
}

const activeLabels = (pathname: string) =>
  [...sidebarLinks(shell(pathname)).entries()].filter(([, link]) => link.active).map(([label]) => label);

test("Attendance is in the teacher sidebar, right after Lectures, and links to /dashboard/attendance", () => {
  const html = shell("/dashboard");
  const links = sidebarLinks(html);
  assert.deepEqual(links.get("Attendance"), { href: "/dashboard/attendance", active: false });
  const labels = [...links.keys()];
  assert.equal(labels.indexOf("Attendance"), labels.indexOf("Lectures") + 1);
  const tag = html.match(/<a [^>]*aria-label="Attendance"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
  assert.match(tag, /lucide-clipboard-check/, "a Lucide icon like the other items");
  assert.match(tag, />Attendance<\/span>/, "the visible label");
});

test("Attendance is active on the overview and on a lecture register page (and nothing else is)", () => {
  assert.deepEqual(activeLabels("/dashboard/attendance"), ["Attendance"]);
  assert.deepEqual(activeLabels("/dashboard/attendance/0b1d2c3e-1111-4111-8111-111111111111"), ["Attendance"]);
});

test("similar prefixes never activate Attendance", () => {
  for (const pathname of [
    "/dashboard/attendance-overview",
    "/dashboard/attendances",
    "/dashboard/attendancex/1",
    "/dashboard/lectures/L1/attendance",
    "/dashboard",
    "/api/lectures/attendance-overview",
    "/dashboard/attendanc",
  ]) {
    assert.equal(sidebarLinks(shell(pathname)).get("Attendance")?.active, false, pathname);
    assert.equal(isNavItemActive(pathname, "/dashboard/attendance"), false, pathname);
  }
});

test("other items keep their exact-match behaviour (no prefix matching added)", () => {
  const paths = [
    "/dashboard",
    "/dashboard/calendar",
    "/dashboard/lectures",
    "/dashboard/lectures/L1",
    "/dashboard/classes",
    "/dashboard/classes/C1",
    "/dashboard/sessions/S1",
    "/dashboard/material-bundles",
    "/dashboard/material-bundles/configuration",
    "/dashboard/attendance",
    "/dashboard/attendance/L1",
  ];
  for (const pathname of paths) {
    for (const [label, link] of sidebarLinks(shell(pathname))) {
      if (label === "Attendance") continue;
      assert.equal(link.active, pathname === link.href, `${label} on ${pathname}`);
    }
  }
  assert.deepEqual(activeLabels("/dashboard/lectures/L1"), [], "a lecture sub-page still activates no item, as before");
  assert.deepEqual(activeLabels("/dashboard/material-bundles/configuration"), ["Paper Config"]);
});

test("matcher: exact for every other href; Attendance only for itself and its sub-paths", () => {
  assert.equal(isNavItemActive("/dashboard/lectures/L1", "/dashboard/lectures"), false);
  assert.equal(isNavItemActive("/dashboard", "/dashboard"), true);
  assert.equal(isNavItemActive("/dashboard/classes", "/dashboard"), false);
  assert.equal(isNavItemActive("/dashboard/attendance", "/dashboard/attendance"), true);
  assert.equal(isNavItemActive("/dashboard/attendance/L1", "/dashboard/attendance"), true);
  assert.equal(isNavItemActive(null, "/dashboard/attendance"), false);
});

test("permissions unchanged: locked while pending like other items; not in the admin sidebar", () => {
  const pending = shell("/dashboard", { isPending: true });
  assert.match(pending, /aria-label="Attendance \(locked until confirmed\)"/);
  assert.equal(sidebarLinks(pending).has("Attendance"), false, "no link while locked");
  assert.match(pending, /aria-label="Lectures \(locked until confirmed\)"/);

  const admin = sidebarLinks(shell("/dashboard/admin", { role: "ADMIN" }));
  assert.equal(admin.has("Attendance"), false);
  assert.deepEqual([...admin.keys()], ["Admin Overview", "Teachers", "Packages"]);
});
