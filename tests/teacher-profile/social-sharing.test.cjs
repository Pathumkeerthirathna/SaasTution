/*
 * Teacher public profile social sharing: site URL helper, link-preview
 * metadata, the public profile data (no email), 404 for unknown / private
 * profiles (page, metadata and preview images), the preview image's photo
 * loading and default-avatar fallback, the share links / copy helper, the
 * header's use of them, and robots.txt.
 *
 *   npm run test:teacher-profile
 *
 * FAKES: lib/prisma.ts is an in-memory teacherProfile table; the public
 * page's client component is replaced by one that writes its props into the
 * HTML (what the real page serialises for the browser). The final PNG
 * rendering (next/og) needs the Next.js runtime and is NOT executed here: the
 * renderer is injected, and the composition is checked as markup.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "..", "..");
require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
// tsx compiles .tsx with the classic JSX runtime here (React.createElement); Next.js uses the automatic one.
globalThis.React = React;

function fakeAt(filename, exports) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
const fake = (relativePath, exports) => fakeAt(path.join(root, relativePath), exports);
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// ---- Fake database ----------------------------------------------------------------------------------------------

const EMAIL = "private.teacher.email@example.test";
const db = { profiles: [], failNext: false, lastSelect: null };
function profileRow(over = {}) {
  return {
    id: "profile-1",
    teacherId: "teacher-1",
    slug: "Pathum-Kumara",
    title: "MR",
    displayName: "Pathum Kumara",
    profileImageUrl: null,
    profileImageStorageKey: null,
    profileImageSha256: null,
    coverImageUrl: null,
    designation: "Mathematics Teacher",
    headline: "Helping students achieve A passes in Mathematics",
    aboutMe: "<p>I teach <b>Combined Maths</b> &amp; Physics.</p>",
    qualificationSummary: null,
    yearsOfExperience: 8,
    phone: "0771234567",
    whatsapp: "0771234567",
    districtId: null,
    cityId: null,
    facebookUrl: null,
    youtubeUrl: null,
    instagramUrl: null,
    tiktokUrl: null,
    websiteUrl: null,
    seoTitle: null,
    seoDescription: null,
    isVerified: true,
    isPublic: true,
    isDisplayQualification: true,
    isDisplayAchievements: true,
    isDisplaySubjects: true,
    profileViewCount: 3,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    qualifications: [],
    teacher: {
      id: "teacher-1",
      name: "Pathum K.",
      email: EMAIL,
      classes: [
        {
          id: "class-1",
          name: "A/L Maths",
          description: null,
          teacherId: "teacher-1",
          monthlyFee: 2500,
          paymentDueWeek: 1,
          startDate: null,
          schedule: "Sat",
          schedules: [],
          students: [{ id: "enrolment-secret-1", isActive: true }],
        },
      ],
    },
    district: null,
    city: null,
    mediums: [],
    ...over,
  };
}

/** Applies a Prisma-style select to a row (nested selects included), so unselected fields never leak. */
function applySelect(row, select) {
  if (!select) return row;
  const out = {};
  for (const [key, spec] of Object.entries(select)) {
    if (spec === true) out[key] = row[key];
    else if (spec && typeof spec === "object") {
      const value = row[key];
      const inner = spec.select;
      if (Array.isArray(value)) out[key] = value.map((v) => applySelect(v, inner));
      else out[key] = value == null ? value : applySelect(value, inner);
    }
  }
  return out;
}

const prisma = {
  teacherProfile: {
    async findFirst({ where, select }) {
      if (db.failNext) {
        db.failNext = false;
        throw new Error("database unavailable");
      }
      db.lastSelect = select;
      const wanted = where.slug.equals.toLowerCase();
      const row = db.profiles.find((p) => p.slug.toLowerCase() === wanted);
      return row ? applySelect(row, select) : null;
    },
  },
};
fake("lib/prisma.ts", { prisma });
fake("services/teacher-profile-section-service.ts", { getTeacherProfileSections: async () => [{ sectionType: "ABOUT_ME" }] });
// The real client component would be serialised into the page for the browser: this stand-in writes the
// same props into the HTML, so the test sees exactly what the browser would receive.
fake("components/teacherProfile/TeacherProfilePage.tsx", {
  __esModule: true,
  default: (props) => React.createElement("script", { type: "application/json", id: "props", dangerouslySetInnerHTML: { __html: JSON.stringify(props) } }),
});

const SITE = require(path.join(root, "lib", "site-url.ts"));
const META = require(path.join(root, "lib", "teacher-profile", "share-metadata.ts"));
const IMG = require(path.join(root, "lib", "teacher-profile", "share-image.tsx"));
const SERVICE = require(path.join(root, "services", "teacher-profile-service.ts"));
const SHARE = require(path.join(root, "components", "teacherProfile", "profile-share.ts"));
const KEYS = require(path.join(root, "lib", "profile-images", "storage-keys.ts"));
const OR = require(path.join(root, "lib", "file-storage", "open-root.ts"));
const page = require(path.join(root, "app", "[slug]", "page.tsx"));
const ogImage = require(path.join(root, "app", "[slug]", "opengraph-image.tsx"));
const twitterImage = require(path.join(root, "app", "[slug]", "twitter-image.tsx"));
const robots = require(path.join(root, "app", "robots.ts"));

const ORIGIN = "https://slclassroom.live";
const savedEnv = { NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL, APP_URL: process.env.APP_URL };
process.env.NEXT_PUBLIC_APP_URL = `${ORIGIN}/`;
delete process.env.APP_URL;
test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
test.beforeEach(() => {
  db.profiles = [];
  db.failNext = false;
});

// ---- Images for the photo loader ----------------------------------------------------------------------------

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89]), Buffer.alloc(100, 7), Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.alloc(120, 3), Buffer.from([0xff, 0xd9])]);
function webp() {
  const body = Buffer.alloc(200, 1);
  body.write("WEBP", 0, "ascii");
  body.write("VP8 ", 4, "ascii");
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(200, 4);
  return Buffer.concat([header, body]);
}

async function withStorage(fn) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "share-"));
  const app = path.join(base, "app");
  const files = path.join(base, "files");
  fs.mkdirSync(path.join(app, "storage", "teachers"), { recursive: true });
  fs.mkdirSync(files);
  const saved = { cwd: process.cwd(), root: process.env.FILE_STORAGE_ROOT };
  process.env.FILE_STORAGE_ROOT = files;
  OR.resetSharedFileStorageCacheForTests();
  process.chdir(app);
  try {
    return await fn({ app, files });
  } finally {
    process.chdir(saved.cwd);
    if (saved.root === undefined) delete process.env.FILE_STORAGE_ROOT;
    else process.env.FILE_STORAGE_ROOT = saved.root;
    OR.resetSharedFileStorageCacheForTests();
    fs.rmSync(base, { recursive: true, force: true });
  }
}
function storePhoto(files, teacherId, bytes, mime) {
  const storedName = KEYS.generateProfilePhotoStoredName(mime);
  const key = KEYS.profilePhotoKey({ teacherId, storedName });
  const file = path.join(files, ...key.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return { key, url: KEYS.profilePhotoUrl({ teacherId, storedName }) };
}

// ==== 1. Site URL ============================================================================================

test("site URL: configured origin only (trailing slashes / paths dropped); https and no localhost in production; dev default", () => {
  const r = SITE.resolveSiteOrigin;
  assert.equal(r({ NEXT_PUBLIC_APP_URL: "https://slclassroom.live/", NODE_ENV: "production" }), ORIGIN);
  assert.equal(r({ NEXT_PUBLIC_APP_URL: "https://slclassroom.live/some/path?x=1#y", NODE_ENV: "production" }), ORIGIN);
  assert.equal(r({ APP_URL: "https://app.example.lk", NODE_ENV: "production" }), "https://app.example.lk");
  for (const bad of ["http://slclassroom.live", "https://localhost:3000", "http://127.0.0.1:3000", "ftp://x", "not a url", "https://user:pw@slclassroom.live", ""]) {
    assert.equal(r({ NEXT_PUBLIC_APP_URL: bad, NODE_ENV: "production" }), SITE.DEFAULT_PUBLIC_SITE_URL, bad);
  }
  assert.equal(r({ NEXT_PUBLIC_APP_URL: "http://localhost:3000/", NODE_ENV: "development" }), "http://localhost:3000");
  assert.equal(r({ NODE_ENV: "test" }), "http://localhost:3000");
});

test("site URL: absolute URLs without doubled slashes or domains; foreign / protocol-relative URLs refused; slugs encoded", () => {
  assert.equal(SITE.absoluteSiteUrl("/api/teacher-photos/t/a.png", ORIGIN), `${ORIGIN}/api/teacher-photos/t/a.png`);
  assert.equal(SITE.absoluteSiteUrl(`${ORIGIN}/x`, ORIGIN), `${ORIGIN}/x`);
  for (const bad of ["//evil.example/x", "https://evil.example/x", "relative/x", "", null]) assert.equal(SITE.absoluteSiteUrl(bad, ORIGIN), null, String(bad));
  assert.equal(SITE.teacherProfileUrl("Pathum-Kumara", ORIGIN), `${ORIGIN}/Pathum-Kumara`);
  assert.equal(SITE.teacherProfileUrl(" a b?c ", ORIGIN), `${ORIGIN}/a%20b%3Fc`);
  assert.equal(SITE.teacherProfileUrl("", ORIGIN), "");
  assert.equal(SITE.teacherProfileUrl(undefined, ORIGIN), "");
  assert.equal(SITE.siteOrigin(), ORIGIN, "the configured NEXT_PUBLIC_APP_URL (trailing slash removed)");
});

// ==== 2. Metadata ===============================================================================================

const shareText = (over = {}) => ({
  slug: "Pathum-Kumara",
  name: "Mr. Pathum Kumara",
  designation: "Mathematics Teacher",
  headline: "Helping students achieve A passes",
  aboutMe: "About me text",
  seoTitle: null,
  seoDescription: null,
  ...over,
});

test("metadata: title priority (seoTitle > name – designation > name > generic)", () => {
  assert.equal(META.teacherShareTitle(shareText({ seoTitle: "Best Maths Teacher in Colombo" })), "Best Maths Teacher in Colombo");
  assert.equal(META.teacherShareTitle(shareText()), "Mr. Pathum Kumara – Mathematics Teacher");
  assert.equal(META.teacherShareTitle(shareText({ designation: null })), "Mr. Pathum Kumara");
  assert.equal(META.teacherShareTitle(shareText({ name: "", designation: null })), "Teacher profile");
});

test("metadata: description priority (seoDescription > headline > aboutMe (<=160) > generic); HTML, entities and control characters removed", () => {
  assert.equal(META.teacherShareDescription(shareText({ seoDescription: "SEO text" })), "SEO text");
  assert.equal(META.teacherShareDescription(shareText()), "Helping students achieve A passes");
  const long = "word ".repeat(80);
  const about = META.teacherShareDescription(shareText({ headline: null, aboutMe: `<script>alert(1)</script><p>${long}</p>` }));
  assert.ok(about.length <= 160, String(about.length));
  assert.ok(about.endsWith("…"));
  assert.doesNotMatch(about, /<|>|script>/);
  const LS = String.fromCharCode(0x2028);
  const ZW = String.fromCharCode(0x200b);
  assert.equal(META.sanitizeShareText(`Line one${LS}line\ttwo${ZW}\u0000 &amp; <b>three</b>`, 160), "Line one line two & three");
  assert.equal(META.teacherShareDescription(shareText({ headline: "  <br/> ", aboutMe: null })), "View Mr. Pathum Kumara's classes, qualifications and achievements on SL Classroom.");
});

test("metadata: canonical, Open Graph (profile) and Twitter large image - absolute URLs on the configured origin", () => {
  const m = META.buildTeacherProfileMetadata(shareText(), ORIGIN);
  assert.equal(m.title, "Mr. Pathum Kumara – Mathematics Teacher");
  assert.equal(m.description, "Helping students achieve A passes");
  assert.equal(m.alternates.canonical, `${ORIGIN}/Pathum-Kumara`);
  assert.deepEqual(m.robots, { index: true, follow: true });
  assert.equal(m.openGraph.type, "profile");
  assert.equal(m.openGraph.siteName, "SL Classroom");
  assert.equal(m.openGraph.url, `${ORIGIN}/Pathum-Kumara`);
  assert.equal(m.openGraph.title, "Mr. Pathum Kumara – Mathematics Teacher | SL Classroom");
  assert.equal(m.twitter.card, "summary_large_image");
  assert.equal(m.twitter.description, m.description);
  const unavailable = META.buildUnavailableProfileMetadata();
  assert.deepEqual(unavailable.robots, { index: false, follow: false });
  assert.doesNotMatch(JSON.stringify(unavailable), /Pathum|Mathematics/);
});

test("metadata: the image tags come from opengraph-image / twitter-image (1200 x 630 PNG); metadataBase makes them absolute", () => {
  for (const mod of [ogImage, twitterImage]) {
    assert.deepEqual(mod.size, { width: 1200, height: 630 });
    assert.equal(mod.contentType, "image/png");
    assert.equal(mod.runtime, "nodejs");
  }
  const layout = code(read("app", "layout.tsx"));
  assert.match(layout, /metadataBase: siteMetadataBase\(\)/);
  assert.match(layout, /siteName: "SL Classroom"/);
});

// ==== 3. Public data, page and 404 =================================================================================

test("public profile data: no email, no enrolment rows, no internal profile / account ids (only the teacher id the sections need)", async () => {
  db.profiles.push(profileRow());
  const profile = await SERVICE.findPublicTeacherProfileBySlug("pathum-kumara");
  const json = JSON.stringify(profile);
  assert.doesNotMatch(json, new RegExp(EMAIL.replace(/\./g, "\\.")));
  assert.doesNotMatch(json, /"email"|enrolment-secret|"students"|"profileId"/);
  assert.equal(profile.teacherId, "teacher-1");
  assert.equal(profile.teacher.name, "Pathum K.");
  assert.equal(profile.phone, "0771234567", "the intentionally public contact number is kept");
  const select = JSON.stringify(db.lastSelect);
  assert.doesNotMatch(select, /"email"|"students"/, "never even read from the database");
});

test("public profile data: unknown and private -> null (404); a database failure is NOT turned into a 404", async () => {
  db.profiles.push(profileRow({ slug: "hidden", isPublic: false }));
  assert.equal(await SERVICE.findPublicTeacherProfileBySlug("nobody"), null);
  assert.equal(await SERVICE.findPublicTeacherProfileBySlug("hidden"), null);
  assert.equal(await SERVICE.getPublicTeacherShareData("hidden"), null);
  db.failNext = true;
  await assert.rejects(() => SERVICE.findPublicTeacherProfileBySlug("pathum-kumara"), /database unavailable/);
  await assert.rejects(() => SERVICE.GetTeacherPublicProfileBySlug("nobody"), /Teacher not found/, "the old throwing wrapper is kept");
});

test("share data: formatted name (title + display name), only preview fields - never email or phone", async () => {
  db.profiles.push(profileRow({ seoTitle: "SEO", seoDescription: "Desc" }));
  const data = await SERVICE.getPublicTeacherShareData("PATHUM-KUMARA");
  assert.equal(data.name, "Mr. Pathum Kumara");
  assert.equal(data.slug, "Pathum-Kumara", "the stored capitals, for the canonical URL");
  assert.deepEqual(Object.keys(data).sort(), ["aboutMe", "designation", "headline", "isVerified", "name", "profileImageSha256", "profileImageStorageKey", "profileImageUrl", "qualifications", "seoDescription", "seoTitle", "slug", "updatedAt", "yearsOfExperience"]);
  assert.doesNotMatch(JSON.stringify(db.lastSelect), /email|phone|whatsapp|students/);
});

test("page: public profile renders (200) without the email anywhere in the HTML payload; metadata is the teacher's", async () => {
  db.profiles.push(profileRow());
  const element = await page.default({ params: { slug: "pathum-kumara" } });
  const html = renderToStaticMarkup(element);
  assert.match(html, /Pathum K\./);
  assert.doesNotMatch(html, new RegExp(EMAIL.replace(/\./g, "\\.")));
  assert.doesNotMatch(html, /enrolment-secret/);
  const meta = await page.generateMetadata({ params: { slug: "pathum-kumara" } });
  assert.equal(meta.title, "Mr. Pathum Kumara – Mathematics Teacher");
  assert.equal(meta.alternates.canonical, `${ORIGIN}/Pathum-Kumara`);
  assert.doesNotMatch(JSON.stringify(meta), new RegExp(`${EMAIL.replace(/\./g, "\\.")}|0771234567`));
  assert.equal(page.dynamic, "force-dynamic");
});

test("page: unknown and private profiles -> notFound() (HTTP 404) and generic noindex metadata", async () => {
  db.profiles.push(profileRow({ slug: "hidden", isPublic: false, displayName: "Secret Teacher" }));
  for (const slug of ["hidden", "nobody"]) {
    await assert.rejects(() => page.default({ params: { slug } }), (e) => e && e.digest === "NEXT_NOT_FOUND", slug);
    const meta = await page.generateMetadata({ params: { slug } });
    assert.deepEqual(meta.robots, { index: false, follow: false });
    assert.doesNotMatch(JSON.stringify(meta), /Secret|Mathematics|teacher-1/);
  }
});

test("preview images: unknown and private profiles get 404 - no image is generated (both Open Graph and Twitter)", async () => {
  db.profiles.push(profileRow({ slug: "hidden", isPublic: false }));
  for (const mod of [ogImage, twitterImage]) {
    for (const slug of ["hidden", "nobody"]) {
      const res = await mod.default({ params: { slug } });
      assert.equal(res.status, 404, slug);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  }
});

// ==== 4. The preview image =============================================================================================

test("photo loader: JPEG and PNG (unified and legacy) are embedded; undecodable WebP, missing, invalid, pending-removal and foreign URLs fall back (null)", async () => {
  await withStorage(async ({ app, files }) => {
    const j = storePhoto(files, "teacher-1", jpeg(), "image/jpeg");
    assert.match(await IMG.loadShareImagePhoto({ profileImageUrl: j.url, profileImageStorageKey: j.key }), /^data:image\/jpeg;base64,/);
    const p = storePhoto(files, "teacher-1", png(), "image/png");
    assert.match(await IMG.loadShareImagePhoto({ profileImageUrl: p.url, profileImageStorageKey: p.key }), /^data:image\/png;base64,/);
    fs.writeFileSync(path.join(app, "storage", "teachers", "teacher-1-1700000000000.png"), png());
    assert.match(await IMG.loadShareImagePhoto({ profileImageUrl: "/uploads/teachers/teacher-1-1700000000000.png", profileImageStorageKey: null }), /^data:image\/png;base64,/);

    const w = storePhoto(files, "teacher-1", webp(), "image/webp");
    assert.equal(await IMG.loadShareImagePhoto({ profileImageUrl: w.url, profileImageStorageKey: w.key }), null, "a WebP that cannot be decoded: default avatar");
    const html = storePhoto(files, "teacher-1", Buffer.from("<html><script>x</script></html>".padEnd(80, " ")), "image/png");
    assert.equal(await IMG.loadShareImagePhoto({ profileImageUrl: html.url, profileImageStorageKey: html.key }), null, "not an image");
    const gone = KEYS.profilePhotoKey({ teacherId: "teacher-1", storedName: KEYS.generateProfilePhotoStoredName("image/png") });
    assert.equal(await IMG.loadShareImagePhoto({ profileImageUrl: "/api/teacher-photos/teacher-1/x.png", profileImageStorageKey: gone }), null, "missing file");
    assert.equal(await IMG.loadShareImagePhoto({ profileImageUrl: null, profileImageStorageKey: j.key }), null, "removal pending: hidden");
    assert.equal(await IMG.loadShareImagePhoto({ profileImageUrl: null, profileImageStorageKey: null }), null, "no photo");
    assert.equal(await IMG.loadShareImagePhoto({ profileImageUrl: "https://evil.example/x.jpg", profileImageStorageKey: null }), null, "foreign URL never fetched");
    assert.equal(await IMG.loadShareImagePhoto({ profileImageUrl: "/uploads/teachers/../../.env", profileImageStorageKey: null }), null);
    assert.equal(await IMG.loadShareImagePhoto({ profileImageUrl: "/x", profileImageStorageKey: "../../etc/passwd" }), null, "malformed key never opened");
  });
});

test("composition: photo embedded when valid; otherwise the default teacher avatar (SVG) - never an empty or broken image; no storage details", () => {
  const data = { ...shareText(), profileImageUrl: "/api/teacher-photos/teacher-1/abc.png", profileImageStorageKey: "Teachers/teacher-1/Profile/Photo/x.png" };
  const withPhoto = renderToStaticMarkup(React.createElement(IMG.ShareImageMarkup, { data, photo: "data:image/png;base64,AAAA" }));
  assert.match(withPhoto, /<img[^>]+src="data:image\/png;base64,AAAA"/);
  assert.doesNotMatch(withPhoto, /viewBox="0 0 240 240"/, "no default avatar next to a real photo");
  const fallback = renderToStaticMarkup(React.createElement(IMG.ShareImageMarkup, { data, photo: null }));
  assert.match(fallback, /<svg[^>]*viewBox="0 0 240 240"/);
  assert.doesNotMatch(fallback, /<img/);
  for (const html of [withPhoto, fallback]) {
    assert.match(html, /Mr\. Pathum Kumara/);
    assert.match(html, /Mathematics Teacher/);
    assert.doesNotMatch(html, /Helping students achieve A passes/, "the headline is not on the card");
    assert.match(html, /SL Classroom/);
    assert.match(html, /slclassroom\.live\/Pathum-Kumara/);
    assert.doesNotMatch(html, /Teachers\/teacher-1|Profile\/Photo|api\/teacher-photos/, "no storage key or internal URL");
  }
});

test("rendering: a photo the renderer cannot decode falls back to the avatar (one retry); without a photo a failure is a real error; PNG + cache headers", async () => {
  const calls = [];
  const render = async (element) => {
    const html = renderToStaticMarkup(element);
    calls.push(html.includes("<img") ? "photo" : "avatar");
    if (html.includes("<img")) throw new Error("cannot decode image");
    return new Uint8Array([1, 2, 3]).buffer;
  };
  const res = await IMG.renderTeacherShareImage({ ...shareText(), profileImageUrl: "/x", profileImageStorageKey: null }, { render, loadPhoto: async () => "data:image/jpeg;base64,AAAA" });
  assert.deepEqual(calls, ["photo", "avatar"]);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("cache-control"), IMG.SHARE_IMAGE_CACHE_CONTROL);
  assert.match(IMG.SHARE_IMAGE_CACHE_CONTROL, /max-age=3600/, "re-generated hourly at most (a changed photo shows up)");
  await assert.rejects(
    () => IMG.renderTeacherShareImage({ ...shareText(), profileImageUrl: null, profileImageStorageKey: null }, { render: async () => { throw new Error("renderer down"); }, loadPhoto: async () => null }),
    /renderer down/
  );
});

// ==== 4b. Credentials on the preview, versioned image URLs ===========================================================

const qual = (title, displayOrder, id = `q-${displayOrder}`) => ({ id, title, displayOrder });

test("share data: the HIGHEST qualification only (lowest displayOrder); a hidden Qualifications section never exposes any other", async () => {
  db.profiles.push(profileRow({ qualifications: [qual("PGDE", 2), qual("BSc (Hons) Mathematics", 1), qual("  ", 0)], profileImageSha256: "a".repeat(64) }));
  let data = await SERVICE.getPublicTeacherShareData("pathum-kumara");
  assert.deepEqual(data.qualifications, ["BSc (Hons) Mathematics"], "section visible: the first non-blank title, never a second one");
  assert.equal(SERVICE.SHARE_QUALIFICATIONS_MAX, 1);
  assert.equal(data.yearsOfExperience, 8);
  assert.equal(data.isVerified, true);
  assert.equal(data.profileImageSha256, "a".repeat(64));
  const q = db.lastSelect.qualifications;
  assert.deepEqual(q.orderBy, [{ displayOrder: "asc" }, { id: "asc" }]);
  assert.equal(q.take, SERVICE.SHARE_QUALIFICATIONS_SCAN, "a few extra rows, so blank titles can be skipped");
  assert.ok(SERVICE.SHARE_QUALIFICATIONS_SCAN > SERVICE.SHARE_QUALIFICATIONS_MAX);

  db.profiles = [profileRow({ isDisplayQualification: false, qualifications: [qual("PGDE", 2), qual("BSc (Hons) Mathematics", 1)] })];
  data = await SERVICE.getPublicTeacherShareData("pathum-kumara");
  assert.deepEqual(data.qualifications, ["BSc (Hons) Mathematics"], "only the best one (public in the header) while the section is hidden");

  db.profiles = [profileRow({ isDisplayQualification: false, qualifications: [qual("  ", 1), qual("Hidden MSc", 2)] })];
  data = await SERVICE.getPublicTeacherShareData("pathum-kumara");
  assert.deepEqual(data.qualifications, [], "section hidden + blank best title: the hidden second one never takes its place");

  db.profiles = [profileRow({ yearsOfExperience: null, isVerified: false })];
  data = await SERVICE.getPublicTeacherShareData("pathum-kumara");
  assert.deepEqual(data.qualifications, []);
  assert.equal(data.yearsOfExperience, null);
  assert.equal(data.isVerified, false);
});

test("image content: name, designation, highest qualification only, '8+ Years Experience'; missing pieces are empty", () => {
  assert.equal(META.shareExperienceLabel(8), "8+ Years Experience");
  assert.equal(META.shareExperienceLabel(1), "1+ Year Experience");
  for (const none of [0, -3, 2.5, 150, null, undefined, NaN]) assert.equal(META.shareExperienceLabel(none), "", String(none));
  assert.deepEqual(META.shareQualificationLines(["<b>BSc</b> (Hons)", "bsc (hons)", "", null, "PGDE"]), ["BSc (Hons)", "PGDE"]);

  const full = META.shareImageContent({ ...shareText(), qualifications: ["BSc", "MSc"], yearsOfExperience: 5, isVerified: true });
  assert.deepEqual(full, { name: "Mr. Pathum Kumara", designation: "Mathematics Teacher", qualification: "BSc", experience: "5+ Years Experience" }, "only the first (highest) qualification");
  const bare = META.shareImageContent({ ...shareText({ designation: null }), qualifications: [], yearsOfExperience: null });
  assert.deepEqual(bare, { name: "Mr. Pathum Kumara", designation: "", qualification: "", experience: "" }, "no headline / description fallback");
  assert.equal(META.shareImageContent({ ...shareText({ name: "  " }) }).name, "SL Classroom Teacher");
});

test("versioned image URLs: absolute on slclassroom.live; stable for the same content; change with photo, name, designation, highest qualification, experience", () => {
  const base = { ...shareText(), qualifications: ["BSc"], yearsOfExperience: 5, isVerified: false, profileImageUrl: "/api/teacher-photos/teacher-1/a.png", profileImageStorageKey: "Teachers/teacher-1/Profile/Photo/a.png", profileImageSha256: "1".repeat(64) };
  const v = META.shareImageVersion(base);
  assert.match(v, /^[0-9a-f]{16}$/);
  assert.equal(META.shareImageVersion({ ...base, headline: "changed", seoTitle: "x", aboutMe: "y" }), v, "text the image does not show does not change it");
  const changes = {
    "new photo file": { profileImageSha256: "2".repeat(64) },
    "new photo URL": { profileImageUrl: "/api/teacher-photos/teacher-1/b.png" },
    "photo removed": { profileImageUrl: null },
    name: { name: "Ms. Nadeesha Perera" },
    designation: { designation: "Physics Lecturer" },
    "highest qualification": { qualifications: ["MSc"] },
    experience: { yearsOfExperience: 6 },
    slug: { slug: "pathum" },
  };
  for (const [label, over] of Object.entries(changes)) assert.notEqual(META.shareImageVersion({ ...base, ...over }), v, label);
  for (const [label, over] of Object.entries({ "a lower qualification": { qualifications: ["BSc", "MSc"] }, "verified flag (not shown)": { isVerified: true } })) {
    assert.equal(META.shareImageVersion({ ...base, ...over }), v, `${label}: not on the image, same URL`);
  }

  const urls = META.shareImageUrls(base, ORIGIN);
  assert.equal(urls.openGraph, `${ORIGIN}/Pathum-Kumara/opengraph-image?v=${v}`);
  assert.equal(urls.twitter, `${ORIGIN}/Pathum-Kumara/twitter-image?v=${v}`);
  assert.equal(META.shareImageUrls({ ...base, slug: "a b" }, ORIGIN).openGraph.startsWith(`${ORIGIN}/a%20b/opengraph-image?v=`), true);
});

test("metadata: og:image / twitter:image are the versioned 1200 x 630 PNG with a per-teacher alt; production never emits localhost", () => {
  const data = { ...shareText(), qualifications: ["BSc"], yearsOfExperience: 5, profileImageUrl: null, profileImageStorageKey: null };
  const m = META.buildTeacherProfileMetadata(data, ORIGIN);
  const v = META.shareImageVersion(data);
  assert.deepEqual(m.openGraph.images, [
    { url: `${ORIGIN}/Pathum-Kumara/opengraph-image?v=${v}`, secureUrl: `${ORIGIN}/Pathum-Kumara/opengraph-image?v=${v}`, type: "image/png", width: 1200, height: 630, alt: "Mr. Pathum Kumara – Mathematics Teacher | SL Classroom" },
  ]);
  assert.deepEqual(m.twitter.images, [{ url: `${ORIGIN}/Pathum-Kumara/twitter-image?v=${v}`, width: 1200, height: 630, alt: "Mr. Pathum Kumara – Mathematics Teacher | SL Classroom" }]);
  const dev = META.buildTeacherProfileMetadata(data, "http://localhost:3000");
  assert.equal("secureUrl" in dev.openGraph.images[0], false, "no og:image:secure_url for a plain-http URL");

  const prodOrigin = SITE.resolveSiteOrigin({ NEXT_PUBLIC_APP_URL: "http://localhost:3000", NODE_ENV: "production" });
  const prod = META.buildTeacherProfileMetadata(data, prodOrigin);
  const json = JSON.stringify(prod);
  assert.doesNotMatch(json, /localhost|127\.0\.0\.1|http:\/\//);
  assert.match(prod.openGraph.images[0].url, /^https:\/\/slclassroom\.live\/Pathum-Kumara\/opengraph-image\?v=[0-9a-f]{16}$/);
  assert.equal(prod.openGraph.url, "https://slclassroom.live/Pathum-Kumara");
});

test("page metadata: the share data's credentials and photo feed the versioned image URL (a new photo -> a new URL)", async () => {
  db.profiles.push(profileRow({ qualifications: [qual("BSc", 1)], profileImageUrl: "/api/teacher-photos/teacher-1/a.png", profileImageStorageKey: "Teachers/teacher-1/Profile/Photo/a.png", profileImageSha256: "1".repeat(64) }));
  const before = (await page.generateMetadata({ params: { slug: "pathum-kumara" } })).openGraph.images[0].url;
  db.profiles[0].profileImageSha256 = "2".repeat(64);
  db.profiles[0].profileImageStorageKey = "Teachers/teacher-1/Profile/Photo/b.png";
  db.profiles[0].profileImageUrl = "/api/teacher-photos/teacher-1/b.png";
  const after = (await page.generateMetadata({ params: { slug: "pathum-kumara" } })).openGraph.images[0].url;
  assert.match(before, /^https:\/\/slclassroom\.live\/Pathum-Kumara\/opengraph-image\?v=[0-9a-f]{16}$/);
  assert.notEqual(after, before);
});

test("composition (split card): photo fills the left 480 x 630; right 720 px: name, designation, highest qualification, experience; nothing else", () => {
  const data = { ...shareText(), qualifications: ["BSc (Hons) Mathematics", "PGDE"], yearsOfExperience: 8, isVerified: true, profileImageUrl: null, profileImageStorageKey: null };
  const element = IMG.ShareImageMarkup({ data, photo: "data:image/jpeg;base64,AAAA" });
  const html = renderToStaticMarkup(element);
  for (const text of ["Mr. Pathum Kumara", "Mathematics Teacher", "BSc (Hons) Mathematics", "8+ Years Experience", "SL Classroom", "slclassroom.live/Pathum-Kumara"]) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(!html.includes("PGDE"), "never the full qualifications list");
  assert.doesNotMatch(html, /Helping students achieve|Verified|Teacher Profile/, "no headline, badge or pill");
  assert.match(html, /<img[^>]+width="480"[^>]+height="630"[^>]+style="[^"]*object-fit:cover/, "the photo fills the 480 x 630 panel");
  const [left, right] = element.props.children;
  assert.equal(left.props.style.width, 480, "left 40%");
  assert.equal(left.props.style.height, 630);
  assert.equal(right.props.style.width, 720, "right 60%");

  const minimal = renderToStaticMarkup(React.createElement(IMG.ShareImageMarkup, { data: { ...shareText({ designation: null, headline: null, aboutMe: null }), profileImageUrl: null, profileImageStorageKey: null }, photo: null }));
  assert.match(minimal, /Mr\. Pathum Kumara/);
  assert.doesNotMatch(minimal, /Experience|undefined|null/, "missing pieces simply left out");
  assert.match(minimal, /<svg[^>]*viewBox="0 0 240 240"/, "default avatar");
  assert.ok(!minimal.includes("height:4px"), "no divider when there are no facts below the name");
});

// ==== 4c. Real photos (sharp), Sinhala / Tamil shaping (pango) =====================================================

const sharpMod = require("sharp");
const sharp = sharpMod.default ?? sharpMod;
const FONTS = require(path.join(root, "lib", "teacher-profile", "share-fonts.ts"));
const ZWJ = String.fromCharCode(0x200d);
const ZWNJ = String.fromCharCode(0x200c);
const SINHALA_NAME = "චමින්ද පෙරේරා";
const SINHALA_DESIGNATION = `ශ්${ZWJ}රී ලංකා ගණිත ගුරුවරයා`;
const TAMIL_NAME = "செல்வம் கோபால்";
const TAMIL_QUALIFICATION = "கணித ஆசிரியர் – B.Sc. (கணிதம்)";

/** A real two-colour image: left half red, right half blue. */
function halves(width, height) {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const left = x < width / 2;
      raw[o] = left ? 220 : 20;
      raw[o + 1] = 20;
      raw[o + 2] = left ? 20 : 220;
      raw[o + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 4 } });
}
const pixel = async (dataUrl, x, y) => {
  const buf = Buffer.from(dataUrl.split(",")[1], "base64");
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const o = (y * info.width + x) * info.channels;
  return { r: data[o], g: data[o + 1], b: data[o + 2], width: info.width, height: info.height, format: (await sharp(buf).metadata()).format };
};

test("photo loader (real files): JPEG, PNG with transparency and WebP all become a 720 x 945 JPEG (the photo panel's shape); EXIF orientation applied", async () => {
  await withStorage(async ({ app, files }) => {
    const jpg = storePhoto(files, "teacher-1", await halves(900, 600).jpeg().toBuffer(), "image/jpeg");
    const pngAlpha = storePhoto(
      files,
      "teacher-1",
      await sharp({ create: { width: 500, height: 500, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(),
      "image/png"
    );
    const webpReal = storePhoto(files, "teacher-1", await halves(640, 640).webp({ quality: 90 }).toBuffer(), "image/webp");
    // Stored landscape (red left, blue right) + EXIF orientation 6 (display rotated 90 deg clockwise): red ends up on TOP.
    const rotated = storePhoto(files, "teacher-1", await halves(800, 400).jpeg().withMetadata({ orientation: 6 }).toBuffer(), "image/jpeg");
    fs.writeFileSync(path.join(app, "storage", "teachers", "teacher-1-1700000000001.webp"), await halves(300, 300).webp().toBuffer());

    for (const [label, p] of [["jpeg", jpg], ["png", pngAlpha], ["webp", webpReal], ["rotated", rotated]]) {
      const url = await IMG.loadShareImagePhoto({ profileImageUrl: p.url, profileImageStorageKey: p.key });
      assert.match(url, /^data:image\/jpeg;base64,/, label);
      const info = await pixel(url, 10, 10);
      assert.equal(info.format, "jpeg", label);
      assert.deepEqual([info.width, info.height], [IMG.SHARE_PHOTO_SIZE.width, IMG.SHARE_PHOTO_SIZE.height], label);
    }
    assert.equal(IMG.SHARE_PHOTO_SIZE.width / IMG.SHARE_PHOTO_SIZE.height, 480 / 630, "exactly the panel's shape");
    // The probes below hold for ANY crop window the "attention" strategy may choose.
    // WebP 640 x 640 (red left half) -> scaled to 945 x 945, a 720-wide window starts at x <= 225: x = 100 is source x <= 325 (red).
    const webpLeft = await pixel(await IMG.loadShareImagePhoto({ profileImageUrl: webpReal.url, profileImageStorageKey: webpReal.key }), 100, 472);
    assert.ok(webpLeft.r > 150 && webpLeft.b < 90, `WebP decoded with its colours: ${JSON.stringify(webpLeft)}`);
    const transparent = await pixel(await IMG.loadShareImagePhoto({ profileImageUrl: pngAlpha.url, profileImageStorageKey: pngAlpha.key }), 360, 472);
    assert.ok(transparent.r > 240 && transparent.g > 240 && transparent.b > 240, "transparency flattened onto white, not black");
    // Displayed 400 x 800 (red top half) -> scaled to 720 x 1440, a 945-high window starts at y <= 495: its top is red, its bottom blue.
    const rotatedUrl = await IMG.loadShareImagePhoto({ profileImageUrl: rotated.url, profileImageStorageKey: rotated.key });
    const top = await pixel(rotatedUrl, 360, 30);
    const bottom = await pixel(rotatedUrl, 360, 915);
    assert.ok(top.r > 150 && top.b < 90, `EXIF orientation: red on top ${JSON.stringify(top)}`);
    assert.ok(bottom.b > 150 && bottom.r < 90, `EXIF orientation: blue at the bottom ${JSON.stringify(bottom)}`);
    assert.match(await IMG.loadShareImagePhoto({ profileImageUrl: "/uploads/teachers/teacher-1-1700000000001.webp", profileImageStorageKey: null }), /^data:image\/jpeg;base64,/, "legacy WebP");
  });
});

test("photo normalisation: an undecodable WebP -> default avatar; a JPEG / PNG sharp cannot decode is passed through for the renderer to try", async () => {
  assert.equal(await IMG.normalizeSharePhoto(webp(), "image/webp"), null);
  assert.match(await IMG.normalizeSharePhoto(png(), "image/png"), /^data:image\/png;base64,/);
  assert.match(await IMG.normalizeSharePhoto(jpeg(), "image/jpeg"), /^data:image\/jpeg;base64,/);
});

test("share text keeps ZWJ / ZWNJ (Sinhala and Tamil spell with them); other invisible characters still removed", () => {
  assert.equal(META.sanitizeShareText(SINHALA_DESIGNATION, 70), SINHALA_DESIGNATION);
  assert.equal(META.sanitizeShareText(`a${ZWNJ}b${String.fromCharCode(0x200b)}c`, 70), `a${ZWNJ}b c`);
  assert.equal(META.shareImageContent({ ...shareText({ name: SINHALA_NAME, designation: SINHALA_DESIGNATION }) }).designation, SINHALA_DESIGNATION);
  const m = META.buildTeacherProfileMetadata({ ...shareText({ name: TAMIL_NAME, designation: "கணித ஆசிரியர்" }) }, ORIGIN);
  assert.equal(m.openGraph.title, `${TAMIL_NAME} – கணித ஆசிரியர் | SL Classroom`);
});

test("complex-script detection: Sinhala and Tamil (also mixed with Latin) need shaping; Latin, digits and empty text do not", () => {
  for (const t of [SINHALA_NAME, TAMIL_NAME, TAMIL_QUALIFICATION, `BSc (${SINHALA_NAME})`]) assert.equal(FONTS.needsComplexShaping(t), true, t);
  for (const t of ["Mr. Pathum Kumara", "8+ Years Experience", "", null, undefined]) assert.equal(FONTS.needsComplexShaping(t), false, String(t));
});

test("fonts: the three Noto files ship with the code (OFL licences alongside) and load for the image renderer", async () => {
  for (const f of ["NotoSans-Regular.ttf", "NotoSansSinhala-Regular.ttf", "NotoSansTamil-Regular.ttf", "OFL-NotoSans.txt", "OFL-NotoSansSinhala.txt", "OFL-NotoSansTamil.txt"]) {
    assert.ok(fs.existsSync(path.join(root, "assets", "fonts", "noto", f)), f);
  }
  const fonts = await FONTS.loadShareSatoriFonts();
  assert.deepEqual(fonts.map((f) => f.name), ["Noto Sans", "Noto Sans Sinhala", "Noto Sans Tamil"]);
  for (const f of fonts) {
    assert.ok(f.data.byteLength > 50_000, f.name);
    assert.equal(Buffer.from(f.data).readUInt32BE(0), 0x00010000, `${f.name}: a TrueType font`);
  }
});

test("shaped text (pango + HarfBuzz): Sinhala and Tamil become transparent PNGs of the text's size, wrapped at the column width", async () => {
  for (const text of [SINHALA_NAME, SINHALA_DESIGNATION, TAMIL_NAME, TAMIL_QUALIFICATION]) {
    const shaped = await FONTS.renderShapedText({ text, sizePx: 30, color: "#0F172A", maxWidth: 614 });
    assert.ok(shaped, text);
    assert.match(shaped.src, /^data:image\/png;base64,/);
    assert.ok(shaped.width > 100 && shaped.width <= 614, `${text}: ${shaped.width}`);
    // One line at 30 px: the line box comes from the script font's own ascent / descent (Tamil ~0.9 em, Sinhala ~1.25 em).
    assert.ok(shaped.height >= 24 && shaped.height < 55, `${text}: one line, ${shaped.height}`);
    const meta = await sharp(Buffer.from(shaped.src.split(",")[1], "base64")).metadata();
    assert.equal(meta.hasAlpha, true);
  }
  const one = await FONTS.renderShapedText({ text: TAMIL_QUALIFICATION, sizePx: 25, color: "#0F172A", maxWidth: 554 });
  const wrapped = await FONTS.renderShapedText({ text: `${TAMIL_QUALIFICATION} ${TAMIL_QUALIFICATION}`, sizePx: 25, color: "#0F172A", maxWidth: 554 });
  assert.ok(wrapped.height > one.height * 1.6, "long text wraps onto a second line");
  assert.ok(wrapped.width <= 554);
  const markup = await FONTS.renderShapedText({ text: "A & B <b>x</b>", sizePx: 20, color: "#0F172A", maxWidth: 300 });
  assert.ok(markup, "markup characters are escaped, not interpreted");
  assert.equal(await FONTS.renderShapedText({ text: SINHALA_NAME, sizePx: 20, color: "red", maxWidth: 300 }), null, "only #rrggbb colours");
});

test("shapeShareTexts: only Sinhala / Tamil pieces are shaped (Latin stays plain text); the markup embeds them as pictures", async () => {
  const data = {
    ...shareText({ name: SINHALA_NAME, designation: "Mathematics Teacher", headline: null }),
    qualifications: [TAMIL_QUALIFICATION, "BSc (Hons) Mathematics"],
    yearsOfExperience: 12,
    profileImageUrl: null,
    profileImageStorageKey: null,
  };
  const shaped = await IMG.shapeShareTexts(data);
  assert.ok(shaped.name && shaped.name.width > 0);
  assert.equal("designation" in shaped, false, "Latin designation: plain text");
  assert.ok(shaped.qualification && shaped.qualification.width <= 720 - 128 - 48 - 18, "the highest qualification, within its column");
  assert.equal("url" in shaped, false);

  const html = renderToStaticMarkup(React.createElement(IMG.ShareImageMarkup, { data, photo: null, shaped }));
  assert.ok(html.includes(`src="${shaped.name.src}"`), "name embedded as its shaped picture");
  assert.ok(html.includes(`src="${shaped.qualification.src}"`));
  assert.ok(!html.includes(SINHALA_NAME), "no unshaped Sinhala text left for the layout engine");
  assert.ok(!html.includes("கணித ஆசிரியர்"), "no unshaped Tamil text");
  assert.ok(!html.includes("BSc (Hons) Mathematics"), "the second qualification is never shown");
  for (const text of ["Mathematics Teacher", "12+ Years Experience", "slclassroom.live/Pathum-Kumara"]) assert.ok(html.includes(text), text);
  assert.deepEqual(await IMG.shapeShareTexts({ ...shareText(), qualifications: ["BSc"], profileImageUrl: null, profileImageStorageKey: null }), {}, "Latin-only profile: nothing shaped");
});

/** Every style object in a rendered element tree (function components expanded). */
function collectStyles(element, out = []) {
  if (Array.isArray(element)) {
    for (const child of element) collectStyles(child, out);
    return out;
  }
  if (!element || typeof element !== "object") return out;
  if (typeof element.type === "function") return collectStyles(element.type(element.props), out);
  if (element.props?.style) out.push({ type: element.type, style: element.props.style });
  collectStyles(element.props?.children, out);
  return out;
}

test("markup: no style property is ever undefined (the image renderer throws on one) - with and without shaped pictures", async () => {
  const data = {
    ...shareText({ slug: "sinhala-teacher", name: SINHALA_NAME, designation: SINHALA_DESIGNATION, headline: TAMIL_NAME }),
    qualifications: [TAMIL_QUALIFICATION, "BSc"],
    yearsOfExperience: 4,
    isVerified: true,
    profileImageUrl: null,
    profileImageStorageKey: null,
  };
  const shaped = await IMG.shapeShareTexts(data);
  assert.ok(shaped.name && shaped.designation && shaped.qualification);
  const noCredentials = { ...data, qualifications: [], yearsOfExperience: null };
  const cases = [
    [data, shaped],
    [data, {}],
    [noCredentials, await IMG.shapeShareTexts(noCredentials)],
    [{ ...shareText(), profileImageUrl: null, profileImageStorageKey: null }, {}],
  ];
  for (const [d, s] of cases) {
    const styles = collectStyles(IMG.ShareImageMarkup({ data: d, photo: "data:image/jpeg;base64,AAAA", shaped: s }));
    assert.ok(styles.length > 10);
    for (const { type, style } of styles) {
      for (const [key, value] of Object.entries(style)) assert.notEqual(value, undefined, `<${String(type)}> style.${key} is undefined`);
    }
  }
  const urlShaped = { url: { src: "data:image/png;base64,URL", width: 200, height: 30 } };
  const urlStyles = collectStyles(IMG.ShareImageMarkup({ data: { ...data, slug: "x" }, photo: null, shaped: urlShaped }));
  assert.ok(urlStyles.some(({ style }) => style.marginLeft === 10 && style.display === "flex"), "a shaped URL keeps its left spacing");
});

test("rendering: a failure with shaped pictures embedded retries once as plain text with the avatar; PNG response", async () => {
  const seen = [];
  const render = async (element) => {
    const html = renderToStaticMarkup(element);
    seen.push(html.includes("data:image/png;base64,SHAPED") ? "shaped" : "plain");
    if (seen.length === 1) throw new Error("renderer failed");
    return new Uint8Array([1]).buffer;
  };
  const data = { ...shareText({ name: SINHALA_NAME }), profileImageUrl: null, profileImageStorageKey: null };
  const res = await IMG.renderTeacherShareImage(data, {
    render,
    loadPhoto: async () => null,
    shapeTexts: async () => ({ name: { src: "data:image/png;base64,SHAPED", width: 300, height: 60 } }),
  });
  assert.deepEqual(seen, ["shaped", "plain"]);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
});

test("image version: design version 4 (split card) so earlier cached previews are replaced", () => {
  assert.equal(META.SHARE_IMAGE_DESIGN_VERSION, "4");
});

// ==== 5. Sharing ===================================================================================================

test("share links: one encoded profile URL for WhatsApp, Telegram, Facebook, LinkedIn, X and email; the formatted name in the message", () => {
  const url = `${ORIGIN}/Pathum-Kumara`;
  const links = SHARE.buildProfileShareLinks(url, "Mr. Pathum Kumara");
  assert.equal(links.whatsapp, `https://wa.me/?text=${encodeURIComponent(`View Mr. Pathum Kumara's teacher profile on SL Classroom: ${url}`)}`);
  assert.equal(links.facebook, `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`);
  assert.equal(links.linkedin, `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`);
  assert.match(links.telegram, new RegExp(`^https://t\\.me/share/url\\?url=${encodeURIComponent(url).replace(/[.?]/g, "\\$&")}&text=`));
  assert.match(links.x, /^https:\/\/twitter\.com\/intent\/tweet\?url=/);
  assert.match(decodeURIComponent(links.email), /Mr\. Pathum Kumara – SL Classroom teacher profile/);
  assert.ok(!("messenger" in links), "no Messenger (needs a Facebook app id)");
  assert.deepEqual(Object.values(SHARE.buildProfileShareLinks("", "x")), ["", "", "", "", "", ""]);
  assert.deepEqual(SHARE.nativeSharePayload(url, "Mr. Pathum Kumara"), { title: "Mr. Pathum Kumara | SL Classroom", text: "View Mr. Pathum Kumara's teacher profile on SL Classroom", url });
});

test("copy link: writes exactly the profile URL; failures (no clipboard, denied) are reported, never thrown; share-sheet dismissal is not an error", async () => {
  const written = [];
  assert.equal(await SHARE.copyProfileLink(`${ORIGIN}/a`, { writeText: async (t) => written.push(t) }), true);
  assert.deepEqual(written, [`${ORIGIN}/a`]);
  assert.equal(await SHARE.copyProfileLink(`${ORIGIN}/a`, { writeText: async () => { throw new Error("denied"); } }), false);
  assert.equal(await SHARE.copyProfileLink(`${ORIGIN}/a`, undefined), false);
  assert.equal(await SHARE.copyProfileLink("", { writeText: async () => undefined }), false);
  assert.equal(SHARE.isShareCancelled({ name: "AbortError" }), true);
  assert.equal(SHARE.isShareCancelled(new Error("x")), false);
});

test("header: one URL from the CURRENT slug; the formatted name; helpers for every target; toasts, no alert / console in sharing; no hard-coded domain", () => {
  const src = read("components", "teacherProfile", "TeacherProfileHeader.tsx");
  const c = code(src);
  assert.match(c, /const profileUrl = teacherProfileUrl\(teacherData\?\.slug\);/);
  assert.match(c, /const shareName = getDisplayName\(teacherData\);/);
  assert.match(c, /navigator\.share\(nativeSharePayload\(profileUrl, shareName\)\)/);
  for (const key of ["whatsapp", "telegram", "facebook", "linkedin", "email", "x"]) assert.match(c, new RegExp(`openShareTarget\\(shareLinks\\.${key}\\)`), key);
  assert.equal((c.match(/copyLink\(\)/g) || []).length, 2, "both copy buttons");
  assert.match(c, /value=\{profileUrl\}/);
  assert.doesNotMatch(src, /slclassroom\.live/, "no hard-coded domain anywhere in the header");
  assert.doesNotMatch(c, /Messenger|dialog\/send/);
  assert.doesNotMatch(c, /Share clicked/);
  const sharing = c.slice(c.indexOf("const profileUrl"), c.indexOf("useEffect(", c.indexOf("const handleShare")));
  assert.doesNotMatch(sharing, /alert\(|console\./);
  assert.match(c, /toast\.success\("Profile link copied\."\)/);
  assert.match(c, /import toast from "react-hot-toast";/);
});

// ==== 6. robots.txt ====================================================================================================

/** robots.txt matching as Google applies it: longest matching rule wins; "$" anchors; Allow wins a tie. */
function allowed(rules, pathname) {
  const match = (pattern) => {
    const anchored = pattern.endsWith("$");
    const body = anchored ? pattern.slice(0, -1) : pattern;
    return anchored ? pathname === body : pathname.startsWith(body);
  };
  let best = { length: -1, allow: true };
  for (const [list, allow] of [[rules.allow, true], [rules.disallow, false]]) {
    for (const pattern of [].concat(list || [])) {
      if (match(pattern) && (pattern.length > best.length || (pattern.length === best.length && allow))) best = { length: pattern.length, allow };
    }
  }
  return best.allow;
}

test("robots.txt: profiles, preview images and public photos crawlable; private areas and the API excluded; slugs that merely start like a private area are not blocked", () => {
  const r = robots.default();
  const rules = r.rules[0];
  assert.equal(rules.userAgent, "*");
  for (const p of ["/", "/pathum-kumara", "/Pathum-Kumara/opengraph-image", "/pathum-kumara/twitter-image", "/api/teacher-photos/t/a.png", "/uploads/teachers/t-1.jpg", "/dashboard-maths", "/students-hub", "/login-help-teacher"]) {
    assert.equal(allowed(rules, p), true, p);
  }
  for (const p of ["/dashboard", "/dashboard/admin", "/api/lectures/1", "/student", "/student/dashboard", "/account/x", "/guardian/x", "/session/join", "/teacher/profile", "/login", "/register", "/reset-password"]) {
    assert.equal(allowed(rules, p), false, p);
  }
  assert.equal(r.host, ORIGIN);
});
