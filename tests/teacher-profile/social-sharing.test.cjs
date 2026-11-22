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

const qual = (title, displayOrder, id = `q-${displayOrder}`) => ({ id, title, displayOrder });
const TEXT = require(path.join(root, "lib", "teacher-profile", "share-text.ts"));

test("share text: '8 years of teaching experience', 'Name | Designation | SL Classroom', detail lines only when set, one line each", () => {
  assert.equal(TEXT.teachingExperienceText(8), "8 years of teaching experience");
  assert.equal(TEXT.teachingExperienceText(1), "1 year of teaching experience");
  for (const none of [0, -3, 2.5, 150, null, undefined, NaN]) assert.equal(TEXT.teachingExperienceText(none), "", String(none));
  assert.equal(TEXT.teacherShareHeading({ name: "Mr. pathum", designation: "IT Teacher" }), "Mr. pathum | IT Teacher | SL Classroom");
  assert.equal(TEXT.teacherShareHeading({ name: "Mr. pathum", designation: "  " }), "Mr. pathum | SL Classroom");
  assert.deepEqual(
    TEXT.teacherShareDetailLines(
      { name: "x", qualification: "Bachelor of Science in Information Technology", yearsOfExperience: 8, phone: "0711455219", whatsapp: "0778112543" },
      "slclassroom.live/pathum"
    ),
    ["Bachelor of Science in Information Technology", "8 years of teaching experience", "Contact: 0711455219", "WhatsApp: 0778112543", "View teacher profile: slclassroom.live/pathum"]
  );
  assert.deepEqual(TEXT.teacherShareDetailLines({ name: "x", qualification: "BSc\nHons", phone: " " }, ""), ["BSc Hons"], "missing pieces left out; no line breaks inside a line");
  assert.equal(TEXT.readableProfileLink("https://slclassroom.live/pathum"), "slclassroom.live/pathum");
});

test("metadata: canonical; page title / search description unchanged; the preview's title 'Name | Designation | SL Classroom' and the details as its description", () => {
  const data = { ...shareText({ name: "Mr. pathum", designation: "IT Teacher", slug: "pathum" }), qualifications: ["Bachelor of Science in Information Technology"], yearsOfExperience: 8, phone: "0711455219", whatsapp: "0778112543" };
  const m = META.buildTeacherProfileMetadata(data, ORIGIN);
  assert.equal(m.title, "Mr. pathum – IT Teacher", "the page <title> keeps its rule");
  assert.equal(m.description, "Helping students achieve A passes", "the search description keeps its rule");
  assert.equal(m.alternates.canonical, `${ORIGIN}/pathum`);
  assert.deepEqual(m.robots, { index: true, follow: true });
  assert.equal(m.openGraph.type, "profile");
  assert.equal(m.openGraph.siteName, "SL Classroom");
  assert.equal(m.openGraph.url, `${ORIGIN}/pathum`);
  assert.equal(m.openGraph.title, "Mr. pathum | IT Teacher | SL Classroom");
  assert.equal(
    m.openGraph.description,
    "Bachelor of Science in Information Technology\n8 years of teaching experience\nContact: 0711455219\nWhatsApp: 0778112543\nView teacher profile: slclassroom.live/pathum"
  );
  assert.equal(m.twitter.card, "summary_large_image");
  assert.equal(m.twitter.title, m.openGraph.title);
  assert.equal(m.twitter.description, m.openGraph.description);

  const bare = META.buildTeacherProfileMetadata({ ...shareText({ designation: null }), qualifications: [], yearsOfExperience: null, phone: null, whatsapp: "" }, ORIGIN);
  assert.equal(bare.openGraph.title, "Mr. Pathum Kumara | SL Classroom");
  assert.equal(bare.openGraph.description, "View teacher profile: slclassroom.live/Pathum-Kumara", "missing details simply left out");
  const unavailable = META.buildUnavailableProfileMetadata();
  assert.deepEqual(unavailable.robots, { index: false, follow: false });
  assert.doesNotMatch(JSON.stringify(unavailable), /Pathum|Mathematics/);
});

test("metadata: the image tags come from opengraph-image / twitter-image; metadataBase makes them absolute", () => {
  for (const mod of [ogImage, twitterImage]) {
    assert.deepEqual(mod.size, { width: 1200, height: 630 });
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

test("share data: formatted name, the public phone / WhatsApp numbers, only preview fields - never the email", async () => {
  db.profiles.push(profileRow({ seoTitle: "SEO", seoDescription: "Desc", phone: "0711455219", whatsapp: "0778112543" }));
  const data = await SERVICE.getPublicTeacherShareData("PATHUM-KUMARA");
  assert.equal(data.name, "Mr. Pathum Kumara");
  assert.equal(data.slug, "Pathum-Kumara", "the stored capitals, for the canonical URL");
  assert.equal(data.phone, "0711455219");
  assert.equal(data.whatsapp, "0778112543");
  assert.deepEqual(Object.keys(data).sort(), ["aboutMe", "designation", "headline", "isVerified", "name", "phone", "profileImageSha256", "profileImageStorageKey", "profileImageUrl", "qualifications", "seoDescription", "seoTitle", "slug", "updatedAt", "whatsapp", "yearsOfExperience"]);
  assert.doesNotMatch(JSON.stringify(db.lastSelect), /email|students/);
});

test("page: public profile renders (200) without the email anywhere; its preview carries the teacher's public details", async () => {
  db.profiles.push(profileRow({ qualifications: [qual("BSc (Hons) Mathematics", 1)] }));
  const element = await page.default({ params: { slug: "pathum-kumara" } });
  const html = renderToStaticMarkup(element);
  assert.match(html, /Pathum K\./);
  assert.doesNotMatch(html, new RegExp(EMAIL.replace(/\./g, "\\.")));
  assert.doesNotMatch(html, /enrolment-secret/);
  const meta = await page.generateMetadata({ params: { slug: "pathum-kumara" } });
  assert.equal(meta.title, "Mr. Pathum Kumara – Mathematics Teacher");
  assert.equal(meta.alternates.canonical, `${ORIGIN}/Pathum-Kumara`);
  assert.equal(meta.openGraph.title, "Mr. Pathum Kumara | Mathematics Teacher | SL Classroom");
  assert.equal(
    meta.openGraph.description,
    "BSc (Hons) Mathematics\n8 years of teaching experience\nContact: 0771234567\nWhatsApp: 0771234567\nView teacher profile: slclassroom.live/Pathum-Kumara"
  );
  assert.doesNotMatch(JSON.stringify(meta), new RegExp(EMAIL.replace(/\./g, "\\.")));
  assert.equal(page.dynamic, "force-dynamic");
});

test("page: unknown and private profiles -> notFound() (HTTP 404) and generic noindex metadata", async () => {
  db.profiles.push(profileRow({ slug: "hidden", isPublic: false, displayName: "Secret Teacher" }));
  for (const slug of ["hidden", "nobody"]) {
    await assert.rejects(() => page.default({ params: { slug } }), (e) => e && e.digest === "NEXT_NOT_FOUND", slug);
    const meta = await page.generateMetadata({ params: { slug } });
    assert.deepEqual(meta.robots, { index: false, follow: false });
    assert.doesNotMatch(JSON.stringify(meta), /Secret|Mathematics|teacher-1|0771234567/);
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

// ==== 4. Qualifications: the highest only, never a hidden one ===========================================================

test("share data: the HIGHEST qualification only (lowest displayOrder); a hidden Qualifications section never exposes any other", async () => {
  db.profiles.push(profileRow({ qualifications: [qual("PGDE", 2), qual("BSc (Hons) Mathematics", 1), qual("  ", 0)], profileImageSha256: "a".repeat(64) }));
  let data = await SERVICE.getPublicTeacherShareData("pathum-kumara");
  assert.deepEqual(data.qualifications, ["BSc (Hons) Mathematics"], "section visible: the first non-blank title, never a second one");
  assert.equal(SERVICE.SHARE_QUALIFICATIONS_MAX, 1);
  assert.equal(data.yearsOfExperience, 8);
  assert.equal(data.profileImageSha256, "a".repeat(64));
  const q = db.lastSelect.qualifications;
  assert.deepEqual(q.orderBy, [{ displayOrder: "asc" }, { id: "asc" }]);
  assert.equal(q.take, SERVICE.SHARE_QUALIFICATIONS_SCAN, "a few extra rows, so blank titles can be skipped");

  db.profiles = [profileRow({ isDisplayQualification: false, qualifications: [qual("PGDE", 2), qual("BSc (Hons) Mathematics", 1)] })];
  data = await SERVICE.getPublicTeacherShareData("pathum-kumara");
  assert.deepEqual(data.qualifications, ["BSc (Hons) Mathematics"], "only the best one (public in the header) while the section is hidden");

  db.profiles = [profileRow({ isDisplayQualification: false, qualifications: [qual("  ", 1), qual("Hidden MSc", 2)] })];
  data = await SERVICE.getPublicTeacherShareData("pathum-kumara");
  assert.deepEqual(data.qualifications, [], "section hidden + blank best title: the hidden second one never takes its place");
  const meta = await page.generateMetadata({ params: { slug: "pathum-kumara" } });
  assert.doesNotMatch(JSON.stringify(meta), /Hidden MSc/);

  db.profiles = [profileRow({ yearsOfExperience: null })];
  data = await SERVICE.getPublicTeacherShareData("pathum-kumara");
  assert.deepEqual(data.qualifications, []);
  assert.equal(data.yearsOfExperience, null);
});

test("preview details: only the first (highest) qualification even if more are passed; text cleaned", () => {
  const d = META.sharePreviewDetails({ ...shareText(), qualifications: ["<b>BSc</b>", "MSc"], yearsOfExperience: 5, phone: " 071 \n 1455219 ", whatsapp: null });
  assert.deepEqual(d, { name: "Mr. Pathum Kumara", designation: "Mathematics Teacher", qualification: "BSc", yearsOfExperience: 5, phone: "071 1455219", whatsapp: "" });
  assert.equal(META.sharePreviewDetails({ ...shareText({ name: "  " }) }).name, "SL Classroom Teacher");
});

// ==== 5. The preview image: the photo only ================================================================================

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
const solid = (width, height, background) => sharp({ create: { width, height, channels: 3, background } });
const pixelAt = async (bytes, x, y) => {
  const { data, info } = await sharp(Buffer.from(bytes)).raw().toBuffer({ resolveWithObject: true });
  const o = (y * info.width + x) * info.channels;
  return { r: data[o], g: data[o + 1], b: data[o + 2] };
};

test("photo loader: the stored bytes and verified type (unified and legacy; JPEG, PNG, WebP); missing, invalid, pending-removal and foreign URLs -> null", async () => {
  await withStorage(async ({ app, files }) => {
    const j = storePhoto(files, "teacher-1", jpeg(), "image/jpeg");
    assert.equal((await IMG.loadSharePhoto({ profileImageUrl: j.url, profileImageStorageKey: j.key })).type, "image/jpeg");
    const p = storePhoto(files, "teacher-1", png(), "image/png");
    assert.equal((await IMG.loadSharePhoto({ profileImageUrl: p.url, profileImageStorageKey: p.key })).type, "image/png");
    fs.writeFileSync(path.join(app, "storage", "teachers", "teacher-1-1700000000000.png"), png());
    assert.equal((await IMG.loadSharePhoto({ profileImageUrl: "/uploads/teachers/teacher-1-1700000000000.png", profileImageStorageKey: null })).type, "image/png", "legacy");
    const w = storePhoto(files, "teacher-1", webp(), "image/webp");
    assert.equal((await IMG.loadSharePhoto({ profileImageUrl: w.url, profileImageStorageKey: w.key })).type, "image/webp");

    const html = storePhoto(files, "teacher-1", Buffer.from("<html><script>x</script></html>".padEnd(80, " ")), "image/png");
    assert.equal(await IMG.loadSharePhoto({ profileImageUrl: html.url, profileImageStorageKey: html.key }), null, "not an image");
    const gone = KEYS.profilePhotoKey({ teacherId: "teacher-1", storedName: KEYS.generateProfilePhotoStoredName("image/png") });
    assert.equal(await IMG.loadSharePhoto({ profileImageUrl: "/api/teacher-photos/teacher-1/x.png", profileImageStorageKey: gone }), null, "missing file");
    assert.equal(await IMG.loadSharePhoto({ profileImageUrl: null, profileImageStorageKey: j.key }), null, "removal pending: hidden");
    assert.equal(await IMG.loadSharePhoto({ profileImageUrl: null, profileImageStorageKey: null }), null, "no photo");
    assert.equal(await IMG.loadSharePhoto({ profileImageUrl: "https://evil.example/x.jpg", profileImageStorageKey: null }), null, "foreign URL never fetched");
    assert.equal(await IMG.loadSharePhoto({ profileImageUrl: "/uploads/teachers/../../.env", profileImageStorageKey: null }), null);
    assert.equal(await IMG.loadSharePhoto({ profileImageUrl: "/x", profileImageStorageKey: "../../etc/passwd" }), null, "malformed key never opened");
  });
});

test("photo size: the photo's own proportions (portrait stays portrait); only extremes trimmed to 3:4 .. 1.91:1; long side 600..1200", () => {
  assert.deepEqual(IMG.sharePhotoSize(1500, 2000), { width: 900, height: 1200 }, "portrait 3:4 kept");
  assert.deepEqual(IMG.sharePhotoSize(4000, 3000), { width: 1200, height: 900 }, "landscape 4:3 kept");
  assert.deepEqual(IMG.sharePhotoSize(800, 800), { width: 800, height: 800 }, "square kept, not enlarged");
  assert.deepEqual(IMG.sharePhotoSize(1080, 1920), { width: 900, height: 1200 }, "phone screenshot 9:16 trimmed to 3:4");
  assert.deepEqual(IMG.sharePhotoSize(4000, 1000), { width: 1200, height: 628 }, "panorama trimmed to 1.91:1");
  assert.deepEqual(IMG.sharePhotoSize(300, 400), { width: 450, height: 600 }, "small photos enlarged to 600 px");
});

test("photo image: ONLY the photo - a solid-colour photo comes out as that colour edge to edge (no white panel, text or border)", async () => {
  const red = { bytes: new Uint8Array(await solid(960, 1200, "#C0392B").jpeg().toBuffer()), type: "image/jpeg" };
  const out = await IMG.sharePhotoImage(red);
  assert.equal(out.contentType, "image/jpeg");
  const meta = await sharp(Buffer.from(out.body)).metadata();
  assert.deepEqual([meta.width, meta.height], [960, 1200], "portrait 4:5, its own proportions");
  for (const [x, y] of [[2, 2], [957, 2], [2, 1197], [957, 1197], [480, 600]]) {
    const c = await pixelAt(out.body, x, y);
    assert.ok(Math.abs(c.r - 0xc0) < 12 && Math.abs(c.g - 0x39) < 12 && Math.abs(c.b - 0x2b) < 12, `pixel ${x},${y} is the photo: ${JSON.stringify(c)}`);
  }
});

test("photo image: JPEG, PNG with transparency and WebP -> JPEG; EXIF orientation applied; at most ~300 KB", async () => {
  const pngAlpha = { bytes: new Uint8Array(await sharp({ create: { width: 500, height: 500, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()), type: "image/png" };
  const outPng = await IMG.sharePhotoImage(pngAlpha);
  assert.equal(outPng.contentType, "image/jpeg");
  const white = await pixelAt(outPng.body, 300, 300);
  assert.ok(white.r > 240 && white.g > 240 && white.b > 240, "transparency flattened onto white, not black");

  const webpReal = { bytes: new Uint8Array(await halves(640, 480).webp({ quality: 90 }).toBuffer()), type: "image/webp" };
  const outWebp = await IMG.sharePhotoImage(webpReal);
  const wm = await sharp(Buffer.from(outWebp.body)).metadata();
  assert.deepEqual([wm.format, wm.width, wm.height], ["jpeg", 640, 480], "WebP decoded; landscape kept at its own size");

  // Stored landscape 800 x 600 (red left, blue right) + EXIF orientation 6: displayed as a 600 x 800 portrait with red on TOP.
  const rotated = { bytes: new Uint8Array(await halves(800, 600).jpeg().withMetadata({ orientation: 6 }).toBuffer()), type: "image/jpeg" };
  const outRot = await IMG.sharePhotoImage(rotated);
  const rm = await sharp(Buffer.from(outRot.body)).metadata();
  assert.deepEqual([rm.width, rm.height], [600, 800], "portrait after EXIF rotation");
  const top = await pixelAt(outRot.body, 300, 40);
  const bottom = await pixelAt(outRot.body, 300, 760);
  assert.ok(top.r > 150 && top.b < 90, `EXIF orientation: red on top ${JSON.stringify(top)}`);
  assert.ok(bottom.b > 150 && bottom.r < 90, `EXIF orientation: blue at the bottom ${JSON.stringify(bottom)}`);

  // A large, detailed photo stays within WhatsApp's preview-image limit.
  const W = 3000, H = 2000;
  const raw = Buffer.alloc(W * H * 3);
  let seed = 7;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = ((i % (W * 3)) / 12 + (seed >> 24)) & 0xff;
  }
  const big = { bytes: new Uint8Array(await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer()), type: "image/jpeg" };
  const outBig = await IMG.sharePhotoImage(big);
  const bm = await sharp(Buffer.from(outBig.body)).metadata();
  assert.deepEqual([bm.width, bm.height], [1200, 800]);
  assert.ok(outBig.body.length <= IMG.SHARE_PHOTO_MAX_BYTES, `${outBig.body.length} bytes`);
});

test("photo image: an undecodable WebP -> null (default avatar); a JPEG / PNG sharp cannot decode is sent as stored", async () => {
  assert.equal(await IMG.sharePhotoImage({ bytes: new Uint8Array(webp()), type: "image/webp" }), null);
  const p = await IMG.sharePhotoImage({ bytes: new Uint8Array(png()), type: "image/png" });
  assert.equal(p.contentType, "image/png");
  assert.deepEqual(Buffer.from(p.body), png());
  assert.equal((await IMG.sharePhotoImage({ bytes: new Uint8Array(jpeg()), type: "image/jpeg" })).contentType, "image/jpeg");
});

test("default avatar: the illustration alone, a square opaque PNG (no text)", async () => {
  const svg = IMG.defaultTeacherAvatarSvg(630);
  assert.match(svg, /viewBox="0 0 240 240"/);
  assert.doesNotMatch(svg, /<text/);
  const img = await IMG.defaultAvatarImage();
  assert.equal(img.contentType, "image/png");
  const meta = await sharp(Buffer.from(img.body)).metadata();
  assert.deepEqual([meta.width, meta.height], [630, 630]);
  const corner = await sharp(Buffer.from(img.body)).ensureAlpha().raw().toBuffer();
  assert.equal(corner[3], 255, "opaque corner (no black / transparent edges in previews)");
});

test("response: the photo (JPEG) when there is one, else the default avatar (PNG); cache headers; never text", async () => {
  const photoBytes = new Uint8Array(await solid(1000, 800, "#2E7D32").jpeg().toBuffer());
  const withPhoto = await IMG.renderTeacherShareImage({ ...shareText(), profileImageUrl: "/x", profileImageStorageKey: null }, { loadPhoto: async () => ({ bytes: photoBytes, type: "image/jpeg" }) });
  assert.equal(withPhoto.status, 200);
  assert.equal(withPhoto.headers.get("content-type"), "image/jpeg");
  assert.equal(withPhoto.headers.get("cache-control"), IMG.SHARE_IMAGE_CACHE_CONTROL);
  assert.match(IMG.SHARE_IMAGE_CACHE_CONTROL, /max-age=3600/);
  const wm = await sharp(Buffer.from(await withPhoto.arrayBuffer())).metadata();
  assert.deepEqual([wm.width, wm.height], [1000, 800], "exactly the photo");

  const none = await IMG.renderTeacherShareImage({ ...shareText(), profileImageUrl: null, profileImageStorageKey: null });
  assert.equal(none.headers.get("content-type"), "image/png");
  const nm = await sharp(Buffer.from(await none.arrayBuffer())).metadata();
  assert.deepEqual([nm.width, nm.height], [630, 630], "the default avatar");

  const unusable = await IMG.renderTeacherShareImage({ ...shareText(), profileImageUrl: "/x", profileImageStorageKey: null }, {
    loadPhoto: async () => ({ bytes: new Uint8Array(webp()), type: "image/webp" }),
  });
  assert.equal(unusable.headers.get("content-type"), "image/png", "an unusable photo falls back to the avatar");
  const src = read("lib", "teacher-profile", "share-image.tsx");
  assert.doesNotMatch(code(src), /fontFamily|SITE_NAME|teacherProfileUrl|<div/, "no text, branding or layout in the image");
});

test("image version: by the photo only (design 5) - a new / removed photo changes the URL, text changes do not", () => {
  assert.equal(META.SHARE_IMAGE_DESIGN_VERSION, "5");
  const base = { ...shareText(), qualifications: ["BSc"], yearsOfExperience: 5, profileImageUrl: "/api/teacher-photos/teacher-1/a.png", profileImageStorageKey: "Teachers/teacher-1/Profile/Photo/a.png", profileImageSha256: "1".repeat(64) };
  const v = META.shareImageVersion(base);
  assert.match(v, /^[0-9a-f]{16}$/);
  for (const [label, over] of Object.entries({
    "new photo file": { profileImageSha256: "2".repeat(64) },
    "new photo URL": { profileImageUrl: "/api/teacher-photos/teacher-1/b.png" },
    "photo removed": { profileImageUrl: null },
    slug: { slug: "pathum" },
  })) {
    assert.notEqual(META.shareImageVersion({ ...base, ...over }), v, label);
  }
  for (const [label, over] of Object.entries({ name: { name: "Ms. X" }, designation: { designation: "Y" }, qualification: { qualifications: ["MSc"] }, experience: { yearsOfExperience: 9 }, phone: { phone: "1" } })) {
    assert.equal(META.shareImageVersion({ ...base, ...over }), v, `${label}: not in the image, same URL`);
  }
  const urls = META.shareImageUrls(base, ORIGIN);
  assert.equal(urls.openGraph, `${ORIGIN}/Pathum-Kumara/opengraph-image?v=${v}`);
  assert.equal(urls.twitter, `${ORIGIN}/Pathum-Kumara/twitter-image?v=${v}`);
});

test("metadata: og:image / twitter:image are the versioned photo with a per-teacher alt (no declared size: the photo's own); production never emits localhost", () => {
  const data = { ...shareText(), qualifications: ["BSc"], yearsOfExperience: 5, profileImageUrl: null, profileImageStorageKey: null };
  const m = META.buildTeacherProfileMetadata(data, ORIGIN);
  const v = META.shareImageVersion(data);
  assert.deepEqual(m.openGraph.images, [{ url: `${ORIGIN}/Pathum-Kumara/opengraph-image?v=${v}`, secureUrl: `${ORIGIN}/Pathum-Kumara/opengraph-image?v=${v}`, alt: "Photo of Mr. Pathum Kumara" }]);
  assert.deepEqual(m.twitter.images, [{ url: `${ORIGIN}/Pathum-Kumara/twitter-image?v=${v}`, alt: "Photo of Mr. Pathum Kumara" }]);
  const dev = META.buildTeacherProfileMetadata(data, "http://localhost:3000");
  assert.equal("secureUrl" in dev.openGraph.images[0], false, "no og:image:secure_url for a plain-http URL");
  const prodOrigin = SITE.resolveSiteOrigin({ NEXT_PUBLIC_APP_URL: "http://localhost:3000", NODE_ENV: "production" });
  const prod = META.buildTeacherProfileMetadata(data, prodOrigin);
  assert.doesNotMatch(JSON.stringify(prod), /localhost|127\.0\.0\.1|http:\/\//);
  assert.match(prod.openGraph.images[0].url, /^https:\/\/slclassroom\.live\/Pathum-Kumara\/opengraph-image\?v=[0-9a-f]{16}$/);
  assert.match(prod.openGraph.description, /View teacher profile: slclassroom\.live\/Pathum-Kumara$/);
});

test("page metadata: a new photo -> a new image URL", async () => {
  db.profiles.push(profileRow({ qualifications: [qual("BSc", 1)], profileImageUrl: "/api/teacher-photos/teacher-1/a.png", profileImageStorageKey: "Teachers/teacher-1/Profile/Photo/a.png", profileImageSha256: "1".repeat(64) }));
  const before = (await page.generateMetadata({ params: { slug: "pathum-kumara" } })).openGraph.images[0].url;
  db.profiles[0].profileImageSha256 = "2".repeat(64);
  db.profiles[0].profileImageStorageKey = "Teachers/teacher-1/Profile/Photo/b.png";
  db.profiles[0].profileImageUrl = "/api/teacher-photos/teacher-1/b.png";
  const after = (await page.generateMetadata({ params: { slug: "pathum-kumara" } })).openGraph.images[0].url;
  assert.match(before, /^https:\/\/slclassroom\.live\/Pathum-Kumara\/opengraph-image\?v=[0-9a-f]{16}$/);
  assert.notEqual(after, before);
});

test("share text keeps ZWJ / ZWNJ (Sinhala and Tamil spell with them); other invisible characters still removed", () => {
  assert.equal(META.sanitizeShareText(SINHALA_DESIGNATION, 70), SINHALA_DESIGNATION);
  assert.equal(META.sanitizeShareText(`a${ZWNJ}b${String.fromCharCode(0x200b)}c`, 70), `a${ZWNJ}b c`);
  assert.equal(META.sharePreviewDetails({ ...shareText({ name: SINHALA_NAME, designation: SINHALA_DESIGNATION }) }).designation, SINHALA_DESIGNATION);
  const m = META.buildTeacherProfileMetadata({ ...shareText({ name: TAMIL_NAME, designation: "கணித ஆசிரியர்" }) }, ORIGIN);
  assert.equal(m.openGraph.title, `${TAMIL_NAME} | கணித ஆசிரியர் | SL Classroom`);
});

test("complex-script detection (share-fonts): Sinhala and Tamil need shaping; Latin, digits and empty text do not", () => {
  for (const t of [SINHALA_NAME, TAMIL_NAME, TAMIL_QUALIFICATION, `BSc (${SINHALA_NAME})`]) assert.equal(FONTS.needsComplexShaping(t), true, t);
  for (const t of ["Mr. Pathum Kumara", "8 years of teaching experience", "", null, undefined]) assert.equal(FONTS.needsComplexShaping(t), false, String(t));
});

// ==== 6. Sharing ===================================================================================================

const DETAILS = { name: "Mr. pathum", designation: "IT Teacher", qualification: "Bachelor of Science in Information Technology", yearsOfExperience: 8, phone: "0711455219", whatsapp: "0778112543" };
const FULL_MESSAGE = [
  "Mr. pathum",
  "IT Teacher",
  "Bachelor of Science in Information Technology",
  "8 years of teaching experience",
  "Contact: 0711455219",
  "WhatsApp: 0778112543",
  `View teacher profile: ${ORIGIN}/pathum`,
].join("\n");

test("share message: name, designation, highest qualification, experience, public phone and WhatsApp, then the profile URL; missing pieces left out", () => {
  assert.equal(SHARE.profileShareMessage(DETAILS, `${ORIGIN}/pathum`), FULL_MESSAGE);
  assert.equal(SHARE.profileShareMessage({ name: "Mr. Nimal", designation: null, qualification: "", yearsOfExperience: null, phone: "", whatsapp: null }, `${ORIGIN}/nimal`), `Mr. Nimal\nView teacher profile: ${ORIGIN}/nimal`);
});

test("share links: WhatsApp carries the full message; Telegram / native sheet the details with the URL attached; X the heading; email the full message", () => {
  const url = `${ORIGIN}/pathum`;
  const links = SHARE.buildProfileShareLinks(url, DETAILS);
  assert.equal(links.whatsapp, `https://wa.me/?text=${encodeURIComponent(FULL_MESSAGE)}`);
  const withoutLink = FULL_MESSAGE.split("\n").slice(0, -1).join("\n");
  assert.equal(links.telegram, `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(withoutLink)}`);
  assert.equal(links.facebook, `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`);
  assert.equal(links.linkedin, `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`);
  assert.equal(links.x, `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent("Mr. pathum | IT Teacher | SL Classroom")}`);
  assert.equal(decodeURIComponent(links.email.split("body=")[1]), FULL_MESSAGE);
  assert.match(decodeURIComponent(links.email), /subject=Mr\. pathum – SL Classroom teacher profile/);
  assert.ok(!("messenger" in links), "no Messenger (needs a Facebook app id)");
  assert.deepEqual(Object.values(SHARE.buildProfileShareLinks("", DETAILS)), ["", "", "", "", "", ""]);
  assert.deepEqual(SHARE.nativeSharePayload(url, DETAILS), { title: "Mr. pathum | IT Teacher | SL Classroom", text: withoutLink, url });
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

test("header: one URL from the CURRENT slug; the details it shows publicly; helpers for every target; toasts, no alert / console in sharing; no hard-coded domain", () => {
  const src = read("components", "teacherProfile", "TeacherProfileHeader.tsx");
  const c = code(src);
  assert.match(c, /const profileUrl = teacherProfileUrl\(teacherData\?\.slug\);/);
  assert.match(c, /const shareName = getDisplayName\(teacherData\);/);
  const details = c.slice(c.indexOf("const shareDetails = {"), c.indexOf("};", c.indexOf("const shareDetails = {")));
  assert.match(details, /name: shareName/);
  assert.match(details, /designation: teacherData\?\.designation/);
  assert.match(details, /qualification: highestQualification\?\.title \?\? teacherData\?\.qualificationSummary/, "the qualification the header itself shows");
  assert.match(details, /yearsOfExperience: teacherData\?\.yearsOfExperience/);
  assert.match(details, /phone: teacherData\?\.phone/);
  assert.match(details, /whatsapp: teacherData\?\.whatsapp/);
  assert.doesNotMatch(details, /email/);
  assert.match(c, /const shareLinks = buildProfileShareLinks\(profileUrl, shareDetails\);/);
  assert.match(c, /navigator\.share\(nativeSharePayload\(profileUrl, shareDetails\)\)/);
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

// ==== 7. robots.txt ====================================================================================================

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
