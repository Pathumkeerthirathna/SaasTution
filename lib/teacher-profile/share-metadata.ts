import type { Metadata } from "next";

import { teacherProfileUrl } from "@/lib/site-url";

/*
 * Teacher public profile: link-preview metadata (title, description,
 * canonical URL, Open Graph, Twitter / X). Pure: built from the PUBLIC share
 * data only (services/teacher-profile-service.ts getPublicTeacherShareData),
 * which never contains email, phone, ids or enrolment data. The preview image
 * comes from app/[slug]/opengraph-image.tsx and twitter-image.tsx (Next.js
 * adds og:image / twitter:image for them, absolute via metadataBase).
 */

export const SITE_NAME = "SL Classroom";
export const SHARE_DESCRIPTION_MAX = 160;
export const SHARE_TITLE_MAX = 70;

export type TeacherShareText = {
  slug: string;
  name: string;
  designation: string | null;
  headline: string | null;
  aboutMe: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
};

/**
 * Plain, single-line text: HTML tags and comments removed, common entities
 * decoded, control / invisible characters removed, whitespace collapsed, then
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
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, " ")
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

/** Metadata of a PUBLIC profile. `origin` is the site origin (lib/site-url.ts). */
export function buildTeacherProfileMetadata(data: TeacherShareText, origin: string): Metadata {
  const title = teacherShareTitle(data);
  const description = teacherShareDescription(data);
  const url = teacherProfileUrl(data.slug, origin);
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
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | ${SITE_NAME}`,
      description,
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
