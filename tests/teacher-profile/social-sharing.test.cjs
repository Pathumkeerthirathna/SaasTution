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
  assert.deepEqual(Object.keys(data).sort(), ["aboutMe", "designation", "headline", "name", "profileImageStorageKey", "profileImageUrl", "seoDescription", "seoTitle", "slug", "updatedAt"]);
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

test("photo loader: JPEG and PNG (unified and legacy) are embedded; WebP, missing, invalid, pending-removal and foreign URLs fall back (null)", async () => {
  await withStorage(async ({ app, files }) => {
    const j = storePhoto(files, "teacher-1", jpeg(), "image/jpeg");
    assert.match(await IMG.loadShareImagePhoto({ profileImageUrl: j.url, profileImageStorageKey: j.key }), /^data:image\/jpeg;base64,/);
    const p = storePhoto(files, "teacher-1", png(), "image/png");
    assert.match(await IMG.loadShareImagePhoto({ profileImageUrl: p.url, profileImageStorageKey: p.key }), /^data:image\/png;base64,/);
    fs.writeFileSync(path.join(app, "storage", "teachers", "teacher-1-1700000000000.png"), png());
    assert.match(await IMG.loadShareImagePhoto({ profileImageUrl: "/uploads/teachers/teacher-1-1700000000000.png", profileImageStorageKey: null }), /^data:image\/png;base64,/);

    const w = storePhoto(files, "teacher-1", webp(), "image/webp");
    assert.equal(await IMG.loadShareImagePhoto({ profileImageUrl: w.url, profileImageStorageKey: w.key }), null, "WebP: default avatar");
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
  assert.doesNotMatch(withPhoto, /<svg/);
  const fallback = renderToStaticMarkup(React.createElement(IMG.ShareImageMarkup, { data, photo: null }));
  assert.match(fallback, /<svg[^>]*viewBox="0 0 240 240"/);
  assert.doesNotMatch(fallback, /<img/);
  for (const html of [withPhoto, fallback]) {
    assert.match(html, /Mr\. Pathum Kumara/);
    assert.match(html, /Mathematics Teacher/);
    assert.match(html, /Helping students achieve A passes/);
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
