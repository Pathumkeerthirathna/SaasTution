import { createHash } from "node:crypto";

import type { Metadata } from "next";

import { teacherProfileUrl } from "@/lib/site-url";

/*
 * Teacher public profile: link-preview metadata (title, description,
 * canonical URL, Open Graph, Twitter / X). Pure: built from the PUBLIC share
 * data only (services/teacher-profile-service.ts getPublicTeacherShareData),
 * which never contains email, phone, ids or enrolment data.
 *
 * The preview image is served by app/[slug]/opengraph-image.tsx and
 * twitter-image.tsx. Its og:image / twitter:image URLs are set HERE (they
 * override the file-convention URLs) with a "?v=" content version: a hash of
 * everything the image shows. WhatsApp, Facebook and Telegram cache previews
 * per image URL for days, so when a teacher changes their photo, name,
 * designation, qualifications or experience the URL changes and the next
 * share fetches the new image. The image route ignores the query.
 */

export const SITE_NAME = "SL Classroom";
export const SHARE_DESCRIPTION_MAX = 160;
export const SHARE_TITLE_MAX = 70;
export const SHARE_IMAGE_SIZE = { width: 1200, height: 630 } as const;
/** Bump when the preview image's DESIGN changes, so every teacher's preview URL changes with it. */
export const SHARE_IMAGE_DESIGN_VERSION = "3";
const QUALIFICATION_MAX = 70;
const IMAGE_DESCRIPTION_MAX = 150;

export type TeacherShareText = {
  slug: string;
  name: string;
  designation: string | null;
  headline: string | null;
  aboutMe: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
};

/** The extra public fields the preview IMAGE shows (optional: missing = not shown). */
export type TeacherShareImageFields = {
  qualifications?: string[] | null;
  yearsOfExperience?: number | null;
  isVerified?: boolean | null;
  profileImageUrl?: string | null;
  profileImageStorageKey?: string | null;
  profileImageSha256?: string | null;
};

export type TeacherShareData = TeacherShareText & TeacherShareImageFields;

/**
 * Plain, single-line text: HTML tags and comments removed, common entities
 * decoded, control / invisible characters removed (ZWJ / ZWNJ are kept: Sinhala
 * and Tamil spell with them, e.g. the conjunct in "Sri"), whitespace collapsed, then
 * shortened at a word boundary with an ellipsis. "" when nothing is left.
 */
export function sanitizeShareText(value: string | null | undefined, max: number): string {
  if (typeof value !== "string") return "";
  let text = value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  text = (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, "");
  return `${text}…`;
}

/** Title: seoTitle; else "Name – Designation"; else the name; else a generic title. */
export function teacherShareTitle(data: TeacherShareText): string {
  const seo = sanitizeShareText(data.seoTitle, SHARE_TITLE_MAX);
  if (seo) return seo;
  const name = sanitizeShareText(data.name, SHARE_TITLE_MAX);
  const designation = sanitizeShareText(data.designation, SHARE_TITLE_MAX);
  if (name && designation) return sanitizeShareText(`${name} – ${designation}`, SHARE_TITLE_MAX);
  return name || "Teacher profile";
}

/** Description: seoDescription; else the headline; else About Me (~160 chars); else a generic line. */
export function teacherShareDescription(data: TeacherShareText): string {
  for (const candidate of [data.seoDescription, data.headline, data.aboutMe]) {
    const text = sanitizeShareText(candidate, SHARE_DESCRIPTION_MAX);
    if (text) return text;
  }
  const name = sanitizeShareText(data.name, SHARE_TITLE_MAX);
  return name
    ? `View ${name}'s classes, qualifications and achievements on ${SITE_NAME}.`
    : `View this teacher's classes, qualifications and achievements on ${SITE_NAME}.`;
}

// ---- What the preview IMAGE shows (shared by the image and its version) ------------------------------------

/** "8+ Years Teaching Experience" / "1+ Year Teaching Experience"; "" when not set, 0 or not a sensible whole number. */
export function shareExperienceLabel(years: number | null | undefined): string {
  if (typeof years !== "number" || !Number.isInteger(years) || years < 1 || years > 99) return "";
  return `${years}+ ${years === 1 ? "Year" : "Years"} Teaching Experience`;
}

/** Clean, non-empty, de-duplicated qualification lines (order kept). */
export function shareQualificationLines(list: readonly (string | null | undefined)[] | null | undefined): string[] {
  const out: string[] = [];
  for (const item of list ?? []) {
    const text = sanitizeShareText(item, QUALIFICATION_MAX);
    if (text && !out.some((existing) => existing.toLowerCase() === text.toLowerCase())) out.push(text);
  }
  return out;
}

/** The image's text, after every fallback (exported for tests). */
export function shareImageContent(data: TeacherShareData) {
  const qualifications = shareQualificationLines(data.qualifications);
  const experience = shareExperienceLabel(data.yearsOfExperience);
  return {
    name: sanitizeShareText(data.name, 60) || `${SITE_NAME} Teacher`,
    designation: sanitizeShareText(data.designation, 60),
    qualifications,
    experience,
    verified: data.isVerified === true,
    // Only when there are no credentials to show, so the card never looks empty.
    description:
      qualifications.length === 0 && !experience
        ? sanitizeShareText(data.seoDescription || data.headline || data.aboutMe, IMAGE_DESCRIPTION_MAX)
        : "",
  };
}

/**
 * The preview image's content version: 16 hex characters of a SHA-256 over
 * everything the image shows (the text after fallbacks, the photo's identity:
 * display URL, storage key and stored SHA-256) and the design version. Same
 * content -> same URL (platform caches stay warm); any visible change -> a
 * new URL (platforms fetch the new image).
 */
export function shareImageVersion(data: TeacherShareData): string {
  const photo = data.profileImageUrl ? [data.profileImageUrl, data.profileImageStorageKey ?? "", data.profileImageSha256 ?? ""] : [];
  const payload = JSON.stringify([SHARE_IMAGE_DESIGN_VERSION, data.slug, shareImageContent(data), photo]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** e.g. "Mr. Pathum Kumara – Mathematics Teacher | SL Classroom" (the image's alt text). */
export function shareImageAlt(data: TeacherShareData): string {
  const { name, designation } = shareImageContent(data);
  return `${designation ? `${name} – ${designation}` : name} | ${SITE_NAME}`;
}

/** Absolute, versioned preview image URLs, e.g. https://slclassroom.live/Pathum-Kumara/opengraph-image?v=1a2b... */
export function shareImageUrls(data: TeacherShareData, origin: string): { openGraph: string; twitter: string } {
  const profile = teacherProfileUrl(data.slug, origin);
  const v = shareImageVersion(data);
  return { openGraph: `${profile}/opengraph-image?v=${v}`, twitter: `${profile}/twitter-image?v=${v}` };
}

/** Metadata of a PUBLIC profile. `origin` is the site origin (lib/site-url.ts). */
export function buildTeacherProfileMetadata(data: TeacherShareData, origin: string): Metadata {
  const title = teacherShareTitle(data);
  const description = teacherShareDescription(data);
  const url = teacherProfileUrl(data.slug, origin);
  const images = shareImageUrls(data, origin);
  const alt = shareImageAlt(data);
  return {
    // The root layout's template adds " | SL Classroom" to the page title.
    title,
    description,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: {
      type: "profile",
      siteName: SITE_NAME,
      url,
      title: `${title} | ${SITE_NAME}`,
      description,
      locale: "en_LK",
      images: [
        {
          url: images.openGraph,
          ...(images.openGraph.startsWith("https://") ? { secureUrl: images.openGraph } : {}),
          type: "image/png",
          ...SHARE_IMAGE_SIZE,
          alt,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | ${SITE_NAME}`,
      description,
      images: [{ url: images.twitter, ...SHARE_IMAGE_SIZE, alt }],
    },
  };
}

/** Unknown or private profile: generic, never indexed; nothing about any teacher. */
export function buildUnavailableProfileMetadata(): Metadata {
  return {
    title: "Teacher profile not found",
    description: `This teacher profile is not available on ${SITE_NAME}.`,
    robots: { index: false, follow: false },
  };
}
