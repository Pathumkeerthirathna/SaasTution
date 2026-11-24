/*
 * Role-aware teacher profile: who sees what on /[slug] (visitor, related
 * student, owner), the student's enrolled / available class split, the
 * student portal "Teacher Profile" list (several teachers), and teacher
 * payment accounts (owner management, primary rules, publication, and
 * authorization: no student writes, no cross-teacher access, no unpublished
 * accounts).
 *
 *   node --test tests/teacher-profile/role-aware-profile.test.cjs
 *
 * FAKES: lib/prisma.ts is an in-memory store that also enforces the
 * migration's rules (one primary per teacher among non-removed rows; a
 * removed row is never primary) after every write, with rollback on error;
 * lib/auth-session.ts returns the session the test sets (the real role
 * source is the signed cookie). The profile page's client component is
 * replaced by one that records its props (what the browser would receive).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "..", "..");
require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
globalThis.React = React;

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

const ORIGIN = "https://slclassroom.live";
process.env.NEXT_PUBLIC_APP_URL = ORIGIN;

// ---- In-memory database -----------------------------------------------------------------------------------

const T_A = "teacher-a";
const T_B = "teacher-b";
const db = { accounts: [], profiles: [], students: [], classes: [], enrolments: [], teachers: [], locks: [], seq: 0 };

function resetDb() {
  db.accounts = [];
  db.locks = [];
  db.seq = 0;
  db.teachers = [
    { id: T_A, name: "Pathum Kumara" },
    { id: T_B, name: "Nadeesha Perera" },
    { id: "teacher-c", name: "Private Teacher" },
  ];
  db.profiles = [
    profileRow({ teacherId: T_A, slug: "pathum", displayName: "Pathum Kumara" }),
    profileRow({ teacherId: T_B, slug: "nadeesha", displayName: "Nadeesha Perera", title: "MS", designation: "Physics Lecturer" }),
    profileRow({ teacherId: "teacher-c", slug: "private-teacher", isPublic: false }),
  ];
  db.classes = [
    { id: "a-maths", teacherId: T_A, status: 0, name: "A/L Maths" },
    { id: "a-physics", teacherId: T_A, status: 0, name: "A/L Physics" },
    { id: "a-ict", teacherId: T_A, status: 0, name: "O/L ICT" },
    { id: "a-removed", teacherId: T_A, status: 1, name: "Old class" },
    { id: "b-chem", teacherId: T_B, status: 0, name: "Chemistry" },
  ];
  db.students = [
    { id: "s1", teacherId: T_A, status: 0 },
    { id: "s2", teacherId: T_A, status: 0 },
    { id: "s3", teacherId: T_B, status: 0 },
    { id: "s4", teacherId: T_B, status: 0 },
    { id: "s-inactive", teacherId: T_A, status: 1 },
  ];
  db.enrolments = [
    { studentId: "s1", classId: "a-maths", isActive: true },
    { studentId: "s1", classId: "a-physics", isActive: false }, // removed from the class
    { studentId: "s1", classId: "a-removed", isActive: true }, // class itself removed
    { studentId: "s1", classId: "b-chem", isActive: true }, // another teacher's class
    { studentId: "s2", classId: "a-ict", isActive: true }, // ANOTHER student: must never show for s1
    { studentId: "s4", classId: "a-ict", isActive: true }, // T_B's student enrolled with T_A
  ];
}

function profileRow(over = {}) {
  return {
    id: `profile-${over.teacherId}`,
    teacherId: over.teacherId,
    slug: over.slug,
    title: "MR",
    displayName: over.displayName ?? null,
    profileImageUrl: null,
    profileImageStorageKey: null,
    profileImageSha256: null,
    coverImageUrl: null,
    designation: "Mathematics Teacher",
    headline: null,
    aboutMe: null,
    qualificationSummary: null,
    yearsOfExperience: 8,
    phone: "0711455219",
    whatsapp: "0778112543",
    districtId: null,
    cityId: null,
    facebookUrl: null,
    youtubeUrl: null,
    instagramUrl: null,
    tiktokUrl: null,
    websiteUrl: null,
    seoTitle: null,
    seoDescription: null,
    isVerified: false,
    isPublic: true,
    isDisplayQualification: true,
    isDisplayAchievements: true,
    isDisplaySubjects: true,
    isDisplayPaymentDetails: true,
    profileViewCount: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    qualifications: [],
    district: null,
    city: null,
    mediums: [],
    ...over,
  };
}

/** The profile row as findPublicTeacherProfileBySlug selects it (teacher + active classes). */
function withTeacher(profile) {
  const teacher = db.teachers.find((t) => t.id === profile.teacherId);
  const classes = db.classes
    .filter((c) => c.teacherId === profile.teacherId && c.status === 0)
    .map((c) => ({ id: c.id, name: c.name, description: null, teacherId: c.teacherId, monthlyFee: 2500, paymentDueWeek: 1, startDate: null, schedule: "Sat", schedules: [] }));
  return { ...profile, teacher: { id: teacher.id, name: teacher.name, email: "private@example.test", classes } };
}

function pick(row, select) {
  if (!select) return { ...row };
  const out = {};
  for (const [key, spec] of Object.entries(select)) if (spec) out[key] = row[key];
  return out;
}

function matches(row, where = {}) {
  for (const [key, value] of Object.entries(where)) {
    if (key === "NOT") {
      if (matches(row, value)) return false;
      continue;
    }
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("in" in value) {
        if (!value.in.includes(row[key])) return false;
        continue;
      }
    }
    if (row[key] !== value) return false;
  }
  return true;
}

function orderAccounts(rows, orderBy = []) {
  return [...rows].sort((a, b) => {
    for (const rule of orderBy) {
      const [key, dir] = Object.entries(rule)[0];
      const av = a[key] instanceof Date ? a[key].getTime() : typeof a[key] === "boolean" ? Number(a[key]) : a[key];
      const bv = b[key] instanceof Date ? b[key].getTime() : typeof b[key] === "boolean" ? Number(b[key]) : b[key];
      if (av < bv) return dir === "asc" ? -1 : 1;
      if (av > bv) return dir === "asc" ? 1 : -1;
    }
    return 0;
  });
}

/** The migration's database rules, checked after every write. */
function assertDbRules() {
  const primaries = new Map();
  for (const row of db.accounts) {
    if (row.status !== 0 && row.isPrimary) throw new Error('violates CHECK "TeacherPaymentAccount_removed_not_primary"');
    if (row.status === 0 && row.isPrimary) {
      if (primaries.has(row.teacherId)) throw new Error('duplicate key value violates unique constraint "TeacherPaymentAccount_one_primary_per_teacher"');
      primaries.set(row.teacherId, row.id);
    }
  }
}

const accountsApi = {
  async findMany({ where, orderBy, select } = {}) {
    return orderAccounts(db.accounts.filter((r) => matches(r, where)), orderBy).map((r) => pick(r, select));
  },
  async findFirst({ where, orderBy, select } = {}) {
    const row = orderAccounts(db.accounts.filter((r) => matches(r, where)), orderBy)[0];
    return row ? pick(row, select) : null;
  },
  async findFirstOrThrow(args) {
    const row = await accountsApi.findFirst(args);
    if (!row) throw new Error("No record found");
    return row;
  },
  async count({ where } = {}) {
    return db.accounts.filter((r) => matches(r, where)).length;
  },
  async create({ data, select }) {
    db.seq += 1;
    const row = {
      id: `acc-${db.seq}`,
      label: null,
      branchName: null,
      accountType: "SAVINGS",
      isPrimary: false,
      isPublic: false,
      isActive: true,
      status: 0,
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, db.seq)),
      updatedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, db.seq)),
      ...data,
    };
    db.accounts.push(row);
    assertDbRules();
    return pick(row, select);
  },
  async updateMany({ where, data }) {
    const rows = db.accounts.filter((r) => matches(r, where));
    for (const row of rows) Object.assign(row, data, { updatedAt: new Date() });
    assertDbRules();
    return { count: rows.length };
  },
};

const prisma = {
  teacherPaymentAccount: accountsApi,
  teacherProfile: {
    async findUnique({ where, select }) {
      const row = db.profiles.find((p) => p.teacherId === where.teacherId);
      return row ? pick(row, select) : null;
    },
    async findFirst({ where }) {
      const wanted = where.slug.equals.toLowerCase();
      const row = db.profiles.find((p) => p.slug.toLowerCase() === wanted);
      return row ? withTeacher(row) : null;
    },
    async update({ where, data, select }) {
      const row = db.profiles.find((p) => p.teacherId === where.teacherId);
      if (!row) throw new Error("Record to update not found.");
      Object.assign(row, data);
      return pick(row, select);
    },
  },
  student: {
    async findUnique({ where, select }) {
      const row = db.students.find((s) => s.id === where.id);
      return row ? pick(row, select) : null;
    },
  },
  classStudent: {
    async findMany({ where, select }) {
      const rows = db.enrolments.filter((e) => {
        if (e.studentId !== where.studentId) return false;
        if (where.isActive !== undefined && e.isActive !== where.isActive) return false;
        const cls = db.classes.find((c) => c.id === e.classId);
        if (where.class?.teacherId !== undefined && cls.teacherId !== where.class.teacherId) return false;
        if (where.class?.status !== undefined && cls.status !== where.class.status) return false;
        return true;
      });
      db.lastEnrolmentQuery = where;
      return rows.map((e) => {
        const cls = db.classes.find((c) => c.id === e.classId);
        return select.class ? { class: { teacherId: cls.teacherId } } : { classId: e.classId };
      });
    },
  },
  teacher: {
    async findMany({ where }) {
      return db.teachers
        .filter((t) => where.id.in.includes(t.id))
        .map((t) => {
          const p = db.profiles.find((x) => x.teacherId === t.id);
          return { id: t.id, name: t.name, profile: p ? { slug: p.slug, isPublic: p.isPublic, title: p.title, displayName: p.displayName, designation: p.designation, profileImageUrl: p.profileImageUrl } : null };
        });
    },
  },
  async $transaction(fn) {
    const snapshot = db.accounts.map((r) => ({ ...r }));
    try {
      return await fn(prisma);
    } catch (error) {
      db.accounts = snapshot; // rollback
      throw error;
    }
  },
  // The advisory lock (pg_advisory_xact_lock returns void: $queryRaw cannot read it, so it must be $executeRaw).
  async $executeRaw(strings, ...values) {
    db.locks.push({ sql: strings.join("?"), values });
    return 1;
  },
  async $queryRaw() {
    throw new Error("$queryRaw is not expected here (a void result cannot be deserialized by Prisma)");
  },
};
fake("lib/prisma.ts", { prisma });

// ---- Session (the real source is the signed cookie; here the test sets it) ----------------------------------

const { AppError } = require(path.join(root, "lib", "error-handler.ts"));
let session = null;
const as = {
  visitor: () => (session = null),
  teacher: (id) => (session = { userId: id, email: `${id}@x.test`, name: id, role: "TEACHER" }),
  student: (id) => (session = { userId: id, email: `${id}@x.test`, name: id, role: "STUDENT" }),
  admin: () => (session = { userId: "admin-1", email: "a@x.test", name: "Admin", role: "ADMIN" }),
};
fake("lib/auth-session.ts", {
  getOptionalSession: async () => session,
  requireTeacherSession: async () => {
    if (!session || session.role !== "TEACHER") throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { teacherId: session.userId, email: session.email, name: session.name, role: "TEACHER" };
  },
  requireTeacherSessionForbiddingOtherRoles: async () => {
    if (!session) throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    if (session.role !== "TEACHER") throw new AppError("Only the teacher who owns this profile can do this.", 403, "FORBIDDEN");
    return { teacherId: session.userId, email: session.email, name: session.name, role: "TEACHER" };
  },
  requireStudentSession: async () => {
    if (!session || session.role !== "STUDENT") throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { studentId: session.userId, email: session.email, name: session.name, role: "STUDENT" };
  },
});
fake("services/teacher-profile-section-service.ts", { getTeacherProfileSections: async () => [] });
let pageProps = null;
fake("components/teacherProfile/TeacherProfilePage.tsx", {
  __esModule: true,
  default: (props) => {
    pageProps = props;
    return React.createElement("script", { type: "application/json", dangerouslySetInnerHTML: { __html: JSON.stringify(props) } });
  },
});

const ACCOUNTS = require(path.join(root, "services", "teacher-payment-account-service.ts"));
const VIEWER = require(path.join(root, "services", "teacher-profile-viewer-service.ts"));
const page = require(path.join(root, "app", "[slug]", "page.tsx"));
const listRoute = require(path.join(root, "app", "api", "teacher", "profile", "payment-accounts", "route.ts"));
const itemRoute = require(path.join(root, "app", "api", "teacher", "profile", "payment-accounts", "[id]", "route.ts"));
const primaryRoute = require(path.join(root, "app", "api", "teacher", "profile", "payment-accounts", "[id]", "primary", "route.ts"));
const visibilityRoute = require(path.join(root, "app", "api", "teacher", "profile", "section-visibility", "route.ts"));
const studentTeachersPage = require(path.join(root, "app", "student", "teacher-profile", "page.tsx"));
const CARD = require(path.join(root, "components", "teacherProfile", "TeacherPaymentDetailsCard.tsx"));

test.beforeEach(() => {
  resetDb();
  as.visitor();
  pageProps = null;
});

const account = (over = {}) => ({ accountHolderName: "P Kumara", bankName: "Bank of Ceylon", branchName: "Maharagama", accountNumber: "8001 2345 67", accountType: "SAVINGS", ...over });
const ids = (rows) => rows.map((r) => r.id);
const primaryOf = (teacherId) => db.accounts.filter((r) => r.teacherId === teacherId && r.status === 0 && r.isPrimary).map((r) => r.id);

function jsonRequest(url, method, body, headers = {}) {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function render(slug, extra = {}) {
  const element = await page.default({ params: { slug }, ...extra });
  renderToStaticMarkup(element);
  return pageProps;
}

// ==== 1. Payment accounts: owner management and the primary rule ==========================================================

test("first account becomes primary; later ones do not unless asked; isPrimary moves the primary (exactly one, in a locked transaction)", async () => {
  const a1 = await ACCOUNTS.createPaymentAccount(T_A, account({ isPrimary: false }));
  assert.equal(a1.isPrimary, true, "the first account is always primary");
  const a2 = await ACCOUNTS.createPaymentAccount(T_A, account({ bankName: "HNB", accountNumber: "1234-5678" }));
  assert.equal(a2.isPrimary, false);
  assert.equal(a2.isPublic, true, "new accounts default to public (the teacher adds them to share them)");
  const a3 = await ACCOUNTS.createPaymentAccount(T_A, account({ bankName: "Sampath", accountNumber: "99887766", isPrimary: true }));
  assert.equal(a3.isPrimary, true);
  assert.deepEqual(primaryOf(T_A), [a3.id], "the old primary was released");
  const list = await ACCOUNTS.listOwnerPaymentAccounts(T_A);
  assert.deepEqual(ids(list), [a3.id, a1.id, a2.id], "primary first, then oldest first");
  assert.ok(db.locks.length >= 3);
  for (const lock of db.locks) {
    assert.match(lock.sql, /pg_advisory_xact_lock\(hashtextextended\(\?, 0\)\)/);
    assert.deepEqual(lock.values, [`teacher-payment-accounts:teacher:${T_A}`], "a per-teacher key in its own namespace, as a bound parameter");
  }
});

test("the advisory lock is taken with $executeRaw (pg_advisory_xact_lock returns void; $queryRaw throws on it in real PostgreSQL)", () => {
  const src = read("services", "teacher-payment-account-service.ts").replace(/\/\/[^\n]*/g, "");
  assert.match(src, /tx\.\$executeRaw`SELECT pg_advisory_xact_lock\(hashtextextended\(\$\{teacherPaymentAccountLockKey\(teacherId\)\}, 0\)\)`/);
  assert.doesNotMatch(src, /\$queryRaw/, "no $queryRaw in this service");
});

test("set primary / update: switches the primary atomically; the current primary cannot be switched off directly", async () => {
  const a1 = await ACCOUNTS.createPaymentAccount(T_A, account());
  const a2 = await ACCOUNTS.createPaymentAccount(T_A, account({ accountNumber: "11112222" }));
  const moved = await ACCOUNTS.setPrimaryPaymentAccount(T_A, a2.id);
  assert.equal(moved.isPrimary, true);
  assert.deepEqual(primaryOf(T_A), [a2.id]);
  await assert.rejects(() => ACCOUNTS.updatePaymentAccount(T_A, a2.id, { isPrimary: false }), (e) => e.statusCode === 409 && e.code === "PRIMARY_ACCOUNT_REQUIRED");
  assert.deepEqual(primaryOf(T_A), [a2.id], "unchanged after the refusal");
  const updated = await ACCOUNTS.updatePaymentAccount(T_A, a1.id, { isPrimary: true, label: "Fees", isPublic: false });
  assert.equal(updated.isPrimary, true);
  assert.equal(updated.label, "Fees");
  assert.equal(updated.isPublic, false);
  assert.deepEqual(primaryOf(T_A), [a1.id]);
});

test("delete: soft delete (status 1, never primary); a removed primary hands over to the oldest remaining account, active ones first", async () => {
  const a1 = await ACCOUNTS.createPaymentAccount(T_A, account());
  const a2 = await ACCOUNTS.createPaymentAccount(T_A, account({ accountNumber: "22223333", isActive: false }));
  const a3 = await ACCOUNTS.createPaymentAccount(T_A, account({ accountNumber: "33334444" }));
  await ACCOUNTS.deletePaymentAccount(T_A, a1.id);
  const removed = db.accounts.find((r) => r.id === a1.id);
  assert.equal(removed.status, 1);
  assert.equal(removed.isPrimary, false);
  assert.deepEqual(primaryOf(T_A), [a3.id], "the active account, not the older inactive one");
  await assert.rejects(() => ACCOUNTS.updatePaymentAccount(T_A, a1.id, { label: "x" }), (e) => e.statusCode === 404, "a removed account cannot be edited");
  await ACCOUNTS.deletePaymentAccount(T_A, a3.id);
  assert.deepEqual(primaryOf(T_A), [a2.id], "only the inactive one is left: it becomes primary (exactly one while any exist)");
  await ACCOUNTS.deletePaymentAccount(T_A, a2.id);
  assert.deepEqual(primaryOf(T_A), []);
  assert.deepEqual(await ACCOUNTS.listOwnerPaymentAccounts(T_A), []);
});

test("multiple accounts per teacher, up to the limit", async () => {
  for (let i = 0; i < 10; i++) await ACCOUNTS.createPaymentAccount(T_A, account({ accountNumber: `1000${i}000` }));
  assert.equal((await ACCOUNTS.listOwnerPaymentAccounts(T_A)).length, 10);
  assert.deepEqual(primaryOf(T_A).length, 1);
  await assert.rejects(() => ACCOUNTS.createPaymentAccount(T_A, account()), (e) => e.statusCode === 409 && e.code === "PAYMENT_ACCOUNT_LIMIT");
});

test("validation: required fields, account number format, enum, and no client-supplied teacher id / status / id", async () => {
  const bad = [
    [account({ accountHolderName: "  " }), /Account holder name is required/],
    [account({ bankName: undefined }), /Bank name is required/],
    [account({ accountNumber: "12AB34" }), /only digits, spaces and hyphens/],
    [account({ accountNumber: "12" }), /between 4 and 30 digits/],
    [account({ accountType: "CRYPTO" }), /valid account type/],
    [{ ...account(), teacherId: T_B }, /./],
    [{ ...account(), status: 1 }, /./],
    [{ ...account(), id: "acc-x" }, /./],
  ];
  for (const [input, message] of bad) {
    await assert.rejects(() => ACCOUNTS.createPaymentAccount(T_A, input), (e) => e.statusCode === 400 && e.code === "VALIDATION_ERROR" && message.test(e.message), JSON.stringify(input));
  }
  assert.equal(db.accounts.length, 0);
  const created = await ACCOUNTS.createPaymentAccount(T_A, account({ label: "", branchName: "", accountNumber: "8001   2345-67" }));
  assert.equal(created.label, null);
  assert.equal(created.branchName, null);
  assert.equal(created.accountNumber, "8001 2345-67");
  await assert.rejects(() => ACCOUNTS.updatePaymentAccount(T_A, created.id, {}), (e) => e.statusCode === 400, "nothing to update");
});

// ==== 2. Cross-teacher protection (IDOR) ==========================================================================================

test("cross-teacher: another teacher's account id is 404 for read-by-id, update, set primary and delete - and nothing changes", async () => {
  const mine = await ACCOUNTS.createPaymentAccount(T_A, account());
  const before = JSON.stringify(db.accounts);
  await assert.rejects(() => ACCOUNTS.updatePaymentAccount(T_B, mine.id, { accountNumber: "66666666" }), (e) => e.statusCode === 404 && e.code === "PAYMENT_ACCOUNT_NOT_FOUND");
  await assert.rejects(() => ACCOUNTS.setPrimaryPaymentAccount(T_B, mine.id), (e) => e.statusCode === 404);
  await assert.rejects(() => ACCOUNTS.deletePaymentAccount(T_B, mine.id), (e) => e.statusCode === 404);
  assert.equal(JSON.stringify(db.accounts), before, "teacher A's account is untouched");
  assert.deepEqual(await ACCOUNTS.listOwnerPaymentAccounts(T_B), [], "a teacher lists only their own accounts");
  await assert.rejects(() => ACCOUNTS.listOwnerPaymentAccounts(""), (e) => e.statusCode === 401);
});

// ==== 3. API routes: teacher-only, own accounts only, same-origin ===================================================================

test("routes: visitors get 401, signed-in students and admins 403, on every operation; nothing is read or written", async () => {
  const mine = await ACCOUNTS.createPaymentAccount(T_A, account());
  await ACCOUNTS.createPaymentAccount(T_A, account({ accountNumber: "20000002", isPublic: false }));
  for (const [who, status] of [[() => as.visitor(), 401], [() => as.student("s1"), 403], [() => as.student("s3"), 403], [() => as.admin(), 403]]) {
    who();
    const list = await listRoute.GET(jsonRequest("/api/teacher/profile/payment-accounts", "GET"));
    assert.equal(list.status, status, "the owner list (private accounts included) is never returned");
    const listText = await list.text();
    assert.ok(!listText.includes("20000002") && !listText.includes(mine.accountNumber), "no account data in the refusal");
    assert.equal((await listRoute.POST(jsonRequest("/api/teacher/profile/payment-accounts", "POST", account({ teacherId: T_A })))).status, status);
    assert.equal((await listRoute.POST(jsonRequest("/api/teacher/profile/payment-accounts", "POST", account()))).status, status);
    assert.equal((await itemRoute.PATCH(jsonRequest(`/api/x/${mine.id}`, "PATCH", { label: "hack" }), { params: { id: mine.id } })).status, status);
    assert.equal((await itemRoute.PATCH(jsonRequest(`/api/x/${mine.id}`, "PATCH", { isPublic: false }), { params: { id: mine.id } })).status, status);
    assert.equal((await itemRoute.DELETE(jsonRequest(`/api/x/${mine.id}`, "DELETE"), { params: { id: mine.id } })).status, status);
    assert.equal((await primaryRoute.POST(jsonRequest(`/api/x/${mine.id}/primary`, "POST"), { params: { id: mine.id } })).status, status);
    if (status === 403) {
      const body = await (await itemRoute.DELETE(jsonRequest(`/api/x/${mine.id}`, "DELETE"), { params: { id: mine.id } })).json();
      assert.equal(body.error.code, "FORBIDDEN");
    }
  }
  assert.equal(db.accounts.length, 2);
  assert.equal(db.accounts[0].label, null);
  assert.equal(db.accounts[0].isPublic, true);
  assert.equal(db.accounts[0].isPrimary, true);
  assert.equal(db.accounts[0].status, 0);
});

test("routes: the owner manages their accounts; another teacher gets 404; cross-site requests are refused before authentication", async () => {
  as.teacher(T_A);
  const created = await listRoute.POST(jsonRequest("/api/teacher/profile/payment-accounts", "POST", account({ teacherId: T_B })));
  assert.equal(created.status, 400, "a client-supplied teacher id is rejected, never used");
  const ok = await listRoute.POST(jsonRequest("/api/teacher/profile/payment-accounts", "POST", account()));
  assert.equal(ok.status, 201);
  const { data } = await ok.json();
  assert.equal(db.accounts[0].teacherId, T_A, "owner from the session");

  as.teacher(T_B);
  assert.equal((await itemRoute.PATCH(jsonRequest(`/api/x/${data.id}`, "PATCH", { label: "mine now" }), { params: { id: data.id } })).status, 404);
  assert.equal((await itemRoute.DELETE(jsonRequest(`/api/x/${data.id}`, "DELETE"), { params: { id: data.id } })).status, 404);
  assert.equal((await primaryRoute.POST(jsonRequest(`/api/x/${data.id}/primary`, "POST"), { params: { id: data.id } })).status, 404);
  const listB = await (await listRoute.GET(jsonRequest("/api/teacher/profile/payment-accounts", "GET"))).json();
  assert.deepEqual(listB.data, []);

  as.teacher(T_A);
  const crossSite = await itemRoute.PATCH(jsonRequest(`/api/x/${data.id}`, "PATCH", { label: "x" }, { "sec-fetch-site": "cross-site", origin: "https://evil.example" }), { params: { id: data.id } });
  assert.equal(crossSite.status, 403);
  assert.equal(db.accounts[0].label, null);
  const patched = await itemRoute.PATCH(jsonRequest(`/api/x/${data.id}`, "PATCH", { label: "Class fees" }), { params: { id: data.id } });
  assert.equal(patched.status, 200);
  assert.equal(db.accounts[0].label, "Class fees");
  assert.equal((await itemRoute.DELETE(jsonRequest(`/api/x/${data.id}`, "DELETE"), { params: { id: data.id } })).status, 200);
  assert.equal(db.accounts[0].status, 1);
});

test("routes: the 'hide all payment details' switch is the existing section-visibility API (owner only)", async () => {
  const toggle = (headers) => visibilityRoute.PATCH(jsonRequest("/api/teacher/profile/section-visibility", "PATCH", { section: "paymentDetails", visible: false }, headers));
  as.visitor();
  assert.equal((await toggle()).status, 401);
  for (const who of [() => as.student("s1"), () => as.admin()]) {
    who();
    assert.equal((await toggle()).status, 403);
    assert.equal((await visibilityRoute.GET(jsonRequest("/api/teacher/profile/section-visibility", "GET"))).status, 403);
  }
  as.teacher(T_A);
  const crossSite = await toggle({ "sec-fetch-site": "cross-site", origin: "https://evil.example" });
  assert.equal(crossSite.status, 403, "cross-site requests are refused before authentication");
  assert.equal(db.profiles.find((p) => p.teacherId === T_A).isDisplayPaymentDetails, true, "nothing changed");
  const res = await visibilityRoute.PATCH(jsonRequest("/api/teacher/profile/section-visibility", "PATCH", { section: "paymentDetails", visible: false }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.isDisplayPaymentDetails, false);
  assert.equal(db.profiles.find((p) => p.teacherId === T_A).isDisplayPaymentDetails, false);
  assert.equal(db.profiles.find((p) => p.teacherId === T_B).isDisplayPaymentDetails, true, "only the session teacher's own profile");
});

// ==== 4. Published accounts (visitors and students) ======================================================================================

test("published accounts: only active + public + non-removed, primary first, display fields only; the master switch hides all", async () => {
  const primary = await ACCOUNTS.createPaymentAccount(T_A, account({ accountNumber: "10000001" }));
  const hidden = await ACCOUNTS.createPaymentAccount(T_A, account({ accountNumber: "20000002", isPublic: false }));
  const inactive = await ACCOUNTS.createPaymentAccount(T_A, account({ accountNumber: "30000003", isActive: false }));
  const removed = await ACCOUNTS.createPaymentAccount(T_A, account({ accountNumber: "40000004" }));
  await ACCOUNTS.deletePaymentAccount(T_A, removed.id);
  await ACCOUNTS.createPaymentAccount(T_A, account({ accountNumber: "50000005", label: "Second" }));
  await ACCOUNTS.createPaymentAccount(T_B, account({ accountNumber: "60000006" }));

  const published = await ACCOUNTS.getPublishedPaymentAccounts(T_A);
  assert.deepEqual(published.map((a) => a.accountNumber), ["10000001", "50000005"]);
  assert.equal(published[0].isPrimary, true);
  for (const a of published) assert.deepEqual(Object.keys(a).sort(), ["accountHolderName", "accountNumber", "accountType", "bankName", "branchName", "isPrimary", "label"], "no id, teacher id, flags or timestamps");
  const all = JSON.stringify(published);
  for (const secret of [hidden, inactive, removed]) assert.ok(!all.includes(secret.accountNumber));
  assert.ok(!all.includes(primary.id));

  db.profiles.find((p) => p.teacherId === T_A).isDisplayPaymentDetails = false;
  assert.deepEqual(await ACCOUNTS.getPublishedPaymentAccounts(T_A), [], "Payment Details switched off: nothing");
  assert.deepEqual(await ACCOUNTS.getPublishedPaymentAccounts(""), []);
});

// ==== 5. The profile page: roles from the server-side session only ======================================================================

test("visitor: the public profile with published accounts only; no student sections; no management", async () => {
  await ACCOUNTS.createPaymentAccount(T_A, account({ accountNumber: "10000001" }));
  await ACCOUNTS.createPaymentAccount(T_A, account({ accountNumber: "20000002", isPublic: false }));
  const props = await render("pathum");
  assert.equal(props.viewerRole, "PUBLIC");
  assert.equal(props.isPublic, true);
  assert.equal(props.studentClasses, undefined);
  assert.deepEqual(props.paymentAccounts.map((a) => a.accountNumber), ["10000001"]);
  assert.deepEqual(props.teacher.classes.map((c) => c.id), ["a-maths", "a-physics", "a-ict"], "the existing public class list (active classes only)");
  const json = JSON.stringify(props);
  assert.ok(!json.includes("20000002"), "an unpublished account never reaches the browser");
  assert.ok(!json.includes("private@example.test"));
  assert.ok(json.includes("0711455219"), "the existing public contact number is kept");
});

test("student of the teacher: enrolled vs available from the student's OWN active enrolments; no other student's data; removed classes and other teachers' classes never appear", async () => {
  as.student("s1");
  const props = await render("pathum");
  assert.equal(props.viewerRole, "STUDENT");
  assert.deepEqual(props.studentClasses.enrolled.map((c) => c.id), ["a-maths"]);
  assert.deepEqual(props.studentClasses.available.map((c) => c.id), ["a-physics", "a-ict"], "an inactive enrolment is not enrolled; s2's enrolment in a-ict is irrelevant");
  const json = JSON.stringify(props.studentClasses);
  assert.ok(!json.includes("a-removed") && !json.includes("b-chem"));
  assert.ok(!/s2|studentId|students|enrol/i.test(JSON.stringify(props.teacher.classes)), "class objects carry no enrolment data");
  assert.equal(db.lastEnrolmentQuery.studentId, "s1", "only the signed-in student's enrolments are read");
  assert.equal(props.isPublic, true, "students stay read-only (no management controls)");
});

test("student related only through an active enrolment is a student viewer; an unrelated student, another teacher and an admin get the public view", async () => {
  as.student("s4"); // T_B's student, enrolled in T_A's a-ict
  let props = await render("pathum");
  assert.equal(props.viewerRole, "STUDENT");
  assert.deepEqual(props.studentClasses.enrolled.map((c) => c.id), ["a-ict"]);

  as.student("s3"); // T_B's student, no enrolment with T_A
  props = await render("pathum");
  assert.equal(props.viewerRole, "PUBLIC");
  assert.equal(props.studentClasses, undefined);

  as.teacher(T_B);
  props = await render("pathum");
  assert.equal(props.viewerRole, "PUBLIC", "another teacher can never manage this profile");

  as.admin();
  assert.equal((await render("pathum")).viewerRole, "PUBLIC");
});

test("owner: the OWNER view (Payment Details management) on their own profile only; a role in the URL is ignored", async () => {
  as.teacher(T_A);
  assert.equal((await render("pathum")).viewerRole, "OWNER");
  assert.equal((await render("nadeesha")).viewerRole, "PUBLIC");
  as.visitor();
  const forged = await render("pathum", { searchParams: { role: "OWNER", studentId: "s1", viewer: "STUDENT" } });
  assert.equal(forged.viewerRole, "PUBLIC");
  assert.equal(forged.studentClasses, undefined);
  const src = read("app", "[slug]", "page.tsx");
  assert.doesNotMatch(src.replace(/\/\/[^\n]*/g, ""), /searchParams|headers\(\)/, "the page reads no client-supplied role");
});

test("private / unknown profiles still 404 for every role", async () => {
  for (const who of [() => as.visitor(), () => as.student("s1"), () => as.teacher("teacher-c")]) {
    who();
    await assert.rejects(() => page.default({ params: { slug: "private-teacher" } }), (e) => e && e.digest === "NEXT_NOT_FOUND");
    await assert.rejects(() => page.default({ params: { slug: "nobody" } }), (e) => e && e.digest === "NEXT_NOT_FOUND");
  }
});

test("viewer service: an inactive student account is never a student viewer", async () => {
  as.student("s-inactive");
  assert.deepEqual(await VIEWER.resolveTeacherProfileViewer(T_A), { role: "PUBLIC" });
  assert.equal(await VIEWER.studentRelatesToTeacher("nobody", T_A), false);
});

// ==== 6. Student portal: Teacher Profile (several teachers) ===================================================================================

test("student teachers: own teacher plus teachers of active enrolments (several possible); private profiles listed without a link", async () => {
  const s1 = await VIEWER.listStudentTeachers("s1");
  assert.deepEqual(s1.map((t) => [t.teacherId, t.slug, t.enrolledClassCount]), [
    [T_A, "pathum", 1],
    [T_B, "nadeesha", 1],
  ], "a-physics (inactive) and a-removed (removed class) are not counted");
  assert.equal(s1[1].name, "Ms. Nadeesha Perera");
  assert.equal(s1[1].designation, "Physics Lecturer");

  db.students.push({ id: "s5", teacherId: "teacher-c", status: 0 });
  const s5 = await VIEWER.listStudentTeachers("s5");
  assert.deepEqual(s5.map((t) => [t.teacherId, t.slug]), [["teacher-c", null]]);
  assert.equal(s5[0].designation, null, "nothing from a private profile");
  assert.deepEqual(await VIEWER.listStudentTeachers("s-inactive"), []);
});

test("student portal page: lists the signed-in student's teachers with links to their profiles; students only", async () => {
  as.student("s1");
  const html = renderToStaticMarkup(await studentTeachersPage.default());
  assert.match(html, /href="\/pathum"/);
  assert.match(html, /href="\/nadeesha"/);
  assert.match(html, /Choose a teacher/);
  as.teacher(T_A);
  await assert.rejects(() => studentTeachersPage.default(), (e) => e.statusCode === 401);
});

test("sidebar: 'Teacher Profile' added after 'My Classes'; every existing item kept in order", () => {
  const { studentNavItems } = require(path.join(root, "components", "student-portal", "student-data.ts"));
  const labels = studentNavItems.map((i) => i.label);
  assert.deepEqual(labels, [
    "Dashboard", "Calendar", "My Classes", "Teacher Profile", "Lecture / Schedules", "Notes", "Recorded Lectures", "Assignments", "Quizzes", "Papers",
    "Payments", "Tutes / Papers", "Attendance / History", "Messages", "My Profile", "Settings",
  ]);
  assert.deepEqual(studentNavItems.find((i) => i.label === "Teacher Profile"), { href: "/student/teacher-profile", label: "Teacher Profile", icon: "teacherProfile" });
  assert.match(read("components", "student-portal", "student-sidebar.tsx"), /teacherProfile: Presentation/);
});

// ==== 7. UI ============================================================================================================================

test("Payment Details (view): a header button only when accounts are published; its dialog lists the primary account highlighted and the others separately, read-only", () => {
  const accounts = [
    { label: "Fees", accountHolderName: "P Kumara", bankName: "BOC", branchName: "Maharagama", accountNumber: "10000001", accountType: "SAVINGS", isPrimary: true },
    { label: null, accountHolderName: "P Kumara", bankName: "HNB", branchName: null, accountNumber: "50000005", accountType: "CURRENT", isPrimary: false },
  ];
  const button = renderToStaticMarkup(React.createElement(CARD.default, { mode: "view", accounts }));
  assert.match(button, /<button[^>]*id="payment-details-button"[^>]*aria-haspopup="dialog"/);
  assert.match(button, /Payment Details/);
  assert.doesNotMatch(button, /role="dialog"/, "the dialog opens on click only");
  assert.equal(renderToStaticMarkup(React.createElement(CARD.default, { mode: "view", accounts: [] })), "", "no button when nothing is published");

  const list = renderToStaticMarkup(React.createElement(CARD.PublishedPaymentDetails, { accounts }));
  assert.match(list, /data-account="primary"[\s\S]*Primary account[\s\S]*10000001/);
  assert.match(list, /Other accounts[\s\S]*data-account="other"[\s\S]*50000005/);
  assert.doesNotMatch(list, /Edit|Delete|Make primary|Add bank account|Make private|Make public/, "read-only for visitors and students");
});

test("profile page component: Payment Details is a header button (manage for the owner, view otherwise), not a card in the page; students get the two class sections", () => {
  const src = read("components", "teacherProfile", "TeacherProfilePage.tsx");
  assert.match(src, /const role: NonNullable<Props\["viewerRole"\]> = isPublic \? viewerRole : "OWNER";/, "isPublic={false} (the owner's own page) is always the owner view");
  assert.match(src, /extraActions=\{[\s\S]*isOwner \? \(\s*<TeacherPaymentDetailsButton mode="manage" \/>\s*\) : \(\s*<TeacherPaymentDetailsButton mode="view" accounts=\{paymentAccounts\} \/>\s*\)/);
  assert.equal((src.match(/<TeacherPaymentDetailsButton/g) || []).length, 2, "only in the header; no full-width card in the layout");
  const grid = src.slice(src.indexOf("{/* Main Content */}"));
  assert.doesNotMatch(grid, /TeacherPaymentDetails/, "nothing Payment Details-related in the page grid");
  assert.match(src, /role === "STUDENT" && studentClasses/);
  assert.match(src, /heading="Your Enrolled Classes"/);
  assert.match(src, /heading="Available Classes"/);
  const header = read("components", "teacherProfile", "TeacherProfileHeader.tsx");
  assert.match(header, /extraActions\?: React\.ReactNode;/);
  assert.match(header, /<div className="flex flex-wrap items-center justify-end gap-2">\s*\{extraActions\}\s*<button\s+type="button"\s+onClick=\{handleShare\}/, "in the header's right-aligned action row, before Share");
  assert.match(read("components", "dashboard-shell.tsx"), /href: "\/dashboard\/teacher\/profile"/);
  for (const page of [["app", "dashboard", "teacher", "profile", "page.tsx"], ["app", "teacher", "profile", "page.tsx"]]) {
    const pageSrc = read(...page);
    assert.match(pageSrc, /requireTeacherSession\(\)/, `${page.join("/")}: teacher session`);
    assert.match(pageSrc, /isPublic=\{false\}/);
    assert.match(pageSrc, /viewerRole="OWNER"/, `${page.join("/")}: owner view`);
  }
  assert.match(read("components", "teacherProfile", "TeacherClassesCard.tsx"), /heading = "Active Classes"/, "the default classes card is unchanged");
});

test("dialog layering: the Add / Edit form is a separate dialog ABOVE the main one; the main dialog stays mounted but hands over focus / Escape / backdrop while the form is open", () => {
  const src = read("components", "teacherProfile", "TeacherPaymentDetailsCard.tsx").replace(/\/\/[^\n]*/g, "");
  // Main dialog: always rendered while open; only its ACTIVE flag follows the form.
  assert.match(src, /<PaymentDialog\s+layer="main"\s+active=\{!formOpen\}/);
  // Form dialog: a sibling rendered only while editing (the main one is not unmounted for it).
  assert.match(src, /\{editing \? \(\s*<PaymentDialog\s+layer="form"\s+active/);
  assert.doesNotMatch(src, /formOpen \? null : <PaymentDialog|!formOpen && <PaymentDialog|editing \? null/, "the main dialog is never unmounted for the form");
  // The modal behaviour (focus trap, inert background, Escape) runs for the active layer only.
  assert.match(src, /useModalDialog\(\{ open: active, dialogRef, overlayRef, canClose, onClose, fallbackId: PAYMENT_DETAILS_BUTTON_ID \}\)/);
  // Backdrop clicks close only an active layer.
  assert.match(src, /if \(event\.target === event\.currentTarget && active && canClose\(\)\) onClose\(\);/);
  // Portalled to <body>; the form layer stacks above the main layer.
  assert.match(src, /createPortal\([\s\S]*document\.body\s*\)/);
  assert.match(src, /layer === "form" \? "z-\[1010\][^"]*" : "z-\[1000\]/);
  // After a save: back to the main dialog, then its list reloads.
  assert.match(src, /setEditing\(null\);\s*await reload\(\);/);
  // The existing APIs, unchanged.
  for (const api of ['"/api/teacher/profile/payment-accounts"', "`${base}/primary`", '"/api/teacher/profile/section-visibility"']) assert.ok(src.includes(api), api);
});

// ==== 8. Database ==========================================================================================================================

test("schema and migration: a dedicated model related to Teacher; one primary per teacher enforced by a partial unique index; existing payment tables untouched", () => {
  const schema = read("prisma", "schema.prisma");
  assert.match(schema, /model TeacherPaymentAccount \{[\s\S]*teacher\s+Teacher\s+@relation\(fields: \[teacherId\], references: \[id\]\)/);
  assert.match(schema, /paymentAccounts TeacherPaymentAccount\[\]/);
  assert.match(schema, /isDisplayPaymentDetails Boolean @default\(true\)/);
  const sql = read("prisma", "migrations", "20261125120000_add_teacher_payment_accounts", "migration.sql");
  assert.match(sql, /CREATE UNIQUE INDEX "TeacherPaymentAccount_one_primary_per_teacher"\s+ON "TeacherPaymentAccount"\("teacherId"\)\s+WHERE "isPrimary" AND "status" = 0;/);
  assert.match(sql, /CHECK \("status" IN \(0, 1\)\)/);
  assert.match(sql, /CHECK \("status" = 0 OR "isPrimary" = false\)/);
  assert.doesNotMatch(sql, /ALTER TABLE "(ClassPayment|ClassStudentFee|ClassFee|PaymentMessage)"/, "no existing payment table is changed");
  assert.doesNotMatch(sql, /^\s*(DROP|DELETE FROM|UPDATE "|TRUNCATE)\b/im, "additive only: no statement drops, deletes or rewrites data");
  assert.doesNotMatch(sql, /DROP (TABLE|COLUMN|INDEX|CONSTRAINT|TYPE)/i);
});

test("Payment Details (read-only): no management control of any kind, and an empty state when nothing is published", () => {
  const accounts = [
    { label: "Fees", accountHolderName: "P Kumara", bankName: "BOC", branchName: "Maharagama", accountNumber: "10000001", accountType: "SAVINGS", isPrimary: true },
    { label: null, accountHolderName: "P Kumara", bankName: "HNB", branchName: null, accountNumber: "50000005", accountType: "CURRENT", isPrimary: false },
  ];
  const list = renderToStaticMarkup(React.createElement(CARD.PublishedPaymentDetails, { accounts }));
  for (const control of [/Add bank account/, />Edit</, />Delete</, /Make (public|private)/, /Set as primary|Make primary/, /Show Payment Details on my public profile/, /type="checkbox"/, /role="switch"/]) {
    assert.doesNotMatch(list, control, String(control));
  }
  const empty = renderToStaticMarkup(React.createElement(CARD.PublishedPaymentDetails, { accounts: [] }));
  assert.match(empty, /data-empty-state="published-payment-accounts"/);
  assert.match(empty, /No payment details published/);
  assert.doesNotMatch(empty, /Add bank account/);

  // The management dialog (owner API calls, Add / Edit / Delete / primary / visibility) is reachable only in mode "manage".
  const source = read("components", "teacherProfile", "TeacherPaymentDetailsCard.tsx");
  assert.match(source, /props\.mode === "manage" \? \(\s*<ManagePaymentDetails/);
  assert.equal((source.match(/<ManagePaymentDetails\b/g) ?? []).length, 1);
});
