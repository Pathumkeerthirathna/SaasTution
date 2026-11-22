import { createHash } from "node:crypto";

import type { Metadata } from "next";

import { teacherProfileUrl } from "@/lib/site-url";
import { readableProfileLink, teacherShareDetailLines, teacherShareHeading, type TeacherShareDetails } from "@/lib/teacher-profile/share-text";

/*
 * Teacher public profile: link-preview metadata (title, description,
 * canonical URL, Open Graph, Twitter / X). Pure: built from the PUBLIC share
 * data only (services/teacher-profile-service.ts getPublicTeacherShareData),
 * which never contains email, ids, enrolment data or hidden qualifications.
 *
 * The link preview is the teacher's PHOTO (app/[slug]/opengraph-image.tsx,
 * twitter-image.tsx: the photo only, no text) with the details as og:title /
 * og:description: "Name | Designation | SL Classroom", then the highest
 * qualification, experience, the public phone / WhatsApp numbers and the
 * profile link. The og:image / twitter:image URLs are set HERE (they override
 * the file-convention URLs) with a "?v=" version of the photo: platforms
 * cache previews per image URL for days, so a new photo gets a new URL. The
 * image route ignores the query.
 */

export const SITE_NAME = "SL Classroom";
export const SHARE_DESCRIPTION_MAX = 160;
export const SHARE_TITLE_MAX = 70;
/** The file-convention default size (app/[slug]/opengraph-image.tsx); the photo keeps its own proportions. */
export const SHARE_IMAGE_SIZE = { width: 1200, height: 630 } as const;
/** Bump when the preview image's DESIGN changes, so every teacher's preview URL changes with it. */
export const SHARE_IMAGE_DESIGN_VERSION = "5";
const QUALIFICATION_MAX = 70;
const CONTACT_MAX = 40;

export type TeacherShareText = {
  slug: string;
  name: string;
  designation: string | null;
  headline: string | null;
  aboutMe: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
};

/** The extra public fields the link preview shows (optional: missing = not shown). */
export type TeacherShareImageFields = {
  qualifications?: string[] | null;
  yearsOfExperience?: number | null;
  /** The phone / WhatsApp numbers the public profile shows. */
  phone?: string | null;
  whatsapp?: string | null;
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

// ---- The link preview: the photo, with the teacher's details as its title and description ----------------

/** Clean, non-empty, de-duplicated qualification lines (order kept). */
export function shareQualificationLines(list: readonly (string | null | undefined)[] | null | undefined): string[] {
  const out: string[] = [];
  for (const item of list ?? []) {
    const text = sanitizeShareText(item, QUALIFICATION_MAX);
    if (text && !out.some((existing) => existing.toLowerCase() === text.toLowerCase())) out.push(text);
  }
  return out;
}

/**
 * The preview's details, cleaned: name, designation, the HIGHEST
 * qualification only (the first of the public, best-first list), years of
 * experience, and the phone / WhatsApp numbers the public profile shows.
 */
export function sharePreviewDetails(data: TeacherShareData): TeacherShareDetails {
  return {
    name: sanitizeShareText(data.name, 60) || `${SITE_NAME} Teacher`,
    designation: sanitizeShareText(data.designation, 60),
    qualification: shareQualificationLines(data.qualifications)[0] ?? "",
    yearsOfExperience: data.yearsOfExperience ?? null,
    phone: sanitizeShareText(data.phone, CONTACT_MAX),
    whatsapp: sanitizeShareText(data.whatsapp, CONTACT_MAX),
  };
}

/** og:title / twitter:title, e.g. "Mr. Pathum Kumara | IT Teacher | SL Classroom". */
export function sharePreviewTitle(data: TeacherShareData): string {
  return teacherShareHeading(sharePreviewDetails(data), SITE_NAME);
}

/**
 * og:description / twitter:description: one detail per line (platforms that
 * do not keep line breaks show them as spaces), e.g.
 *   Bachelor of Science in Information Technology
 *   8 years of teaching experience
 *   Contact: 0711455219
 *   WhatsApp: 0778112543
 *   View teacher profile: slclassroom.live/pathum
 */
export function sharePreviewDescription(data: TeacherShareData, origin: string): string {
  return teacherShareDetailLines(sharePreviewDetails(data), readableProfileLink(teacherProfileUrl(data.slug, origin))).join("\n");
}

/**
 * The preview image's version: 16 hex characters of a SHA-256 over what the
 * image IS - the photo's identity (display URL, storage key, stored SHA-256;
 * or "no photo" = the default avatar) - and the design version. A new or
 * removed photo -> a new URL (platforms fetch the new image); text changes do
 * not touch the image (the details are in the title / description, which
 * platforms re-read with the page).
 */
export function shareImageVersion(data: TeacherShareData): string {
  const photo = data.profileImageUrl ? [data.profileImageUrl, data.profileImageStorageKey ?? "", data.profileImageSha256 ?? ""] : [];
  const payload = JSON.stringify([SHARE_IMAGE_DESIGN_VERSION, data.slug, photo]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** e.g. "Photo of Mr. Pathum Kumara" (the image's alt text). */
export function shareImageAlt(data: TeacherShareData): string {
  return `Photo of ${sharePreviewDetails(data).name}`;
}

/** Absolute, versioned preview image URLs, e.g. https://slclassroom.live/Pathum-Kumara/opengraph-image?v=1a2b... */
export function shareImageUrls(data: TeacherShareData, origin: string): { openGraph: string; twitter: string } {
  const profile = teacherProfileUrl(data.slug, origin);
  const v = shareImageVersion(data);
  return { openGraph: `${profile}/opengraph-image?v=${v}`, twitter: `${profile}/twitter-image?v=${v}` };
}

/**
 * Metadata of a PUBLIC profile. `origin` is the site origin (lib/site-url.ts).
 * The page <title> and search description are unchanged; the link preview
 * (Open Graph / Twitter) carries the teacher's details. The image's size and
 * type are not declared: it is the photo in its own proportions (JPEG), or the
 * default avatar (PNG).
 */
export function buildTeacherProfileMetadata(data: TeacherShareData, origin: string): Metadata {
  const title = teacherShareTitle(data);
  const description = teacherShareDescription(data);
  const url = teacherProfileUrl(data.slug, origin);
  const previewTitle = sharePreviewTitle(data);
  const previewDescription = sharePreviewDescription(data, origin);
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
      title: previewTitle,
      description: previewDescription,
      locale: "en_LK",
      images: [{ url: images.openGraph, ...(images.openGraph.startsWith("https://") ? { secureUrl: images.openGraph } : {}), alt }],
    },
    twitter: {
      card: "summary_large_image",
      title: previewTitle,
      description: previewDescription,
      images: [{ url: images.twitter, alt }],
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
