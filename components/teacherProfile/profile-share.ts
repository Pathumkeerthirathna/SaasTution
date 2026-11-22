import { shareLine, teacherShareDetailLines, teacherShareHeading, type TeacherShareDetails } from "@/lib/teacher-profile/share-text";

/*
 * Teacher profile sharing (the Share button and dialog in
 * TeacherProfileHeader). Pure helpers: the share-target links for ONE profile
 * URL (lib/site-url.ts teacherProfileUrl, built from the CURRENT slug), the
 * native Web Share payload, and copying with a reported outcome. No
 * Messenger link: Facebook's "send" dialog requires an app id this project
 * does not have, so it cannot work.
 *
 * The message carries the teacher's PUBLIC details (lib/teacher-profile/
 * share-text.ts, the same lines as the link preview's description): name,
 * designation, highest qualification, years of experience, the public phone
 * and WhatsApp numbers, and the profile URL.
 */

export type { TeacherShareDetails };

export type ProfileShareLinks = {
  whatsapp: string;
  telegram: string;
  facebook: string;
  linkedin: string;
  x: string;
  email: string;
};

/** The message lines without the profile link (for targets that attach the URL themselves). */
function messageLines(details: TeacherShareDetails): string[] {
  return [shareLine(details.name) || "Teacher profile", shareLine(details.designation), ...teacherShareDetailLines(details, "")].filter(Boolean);
}

/**
 * The full share message, one detail per line, ending with the profile URL:
 *   Mr. Pathum Kumara
 *   IT Teacher
 *   Bachelor of Science in Information Technology
 *   8 years of teaching experience
 *   Contact: 0711455219
 *   WhatsApp: 0778112543
 *   View teacher profile: https://slclassroom.live/pathum
 */
export function profileShareMessage(details: TeacherShareDetails, profileUrl: string): string {
  return [...messageLines(details), ...(profileUrl ? [`View teacher profile: ${profileUrl}`] : [])].join("\n");
}

/** Every share target for one profile URL (all values encoded). Empty strings when there is no URL. */
export function buildProfileShareLinks(profileUrl: string, details: TeacherShareDetails): ProfileShareLinks {
  if (!profileUrl) return { whatsapp: "", telegram: "", facebook: "", linkedin: "", x: "", email: "" };
  const url = encodeURIComponent(profileUrl);
  const full = profileShareMessage(details, profileUrl);
  const withoutLink = messageLines(details).join("\n");
  return {
    whatsapp: `https://wa.me/?text=${encodeURIComponent(full)}`,
    // Telegram shows the URL itself, above the text.
    telegram: `https://t.me/share/url?url=${url}&text=${encodeURIComponent(withoutLink)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${url}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
    // X: the short heading (the post length is limited); the preview card carries the rest.
    x: `https://twitter.com/intent/tweet?url=${url}&text=${encodeURIComponent(teacherShareHeading(details))}`,
    email: `mailto:?subject=${encodeURIComponent(`${shareLine(details.name) || "Teacher"} – SL Classroom teacher profile`)}&body=${encodeURIComponent(full)}`,
  };
}

/** The native share sheet's payload (Web Share API): the details as text, the URL attached by the platform. */
export function nativeSharePayload(profileUrl: string, details: TeacherShareDetails): ShareData {
  return { title: teacherShareHeading(details), text: messageLines(details).join("\n"), url: profileUrl };
}

/** True when the user dismissed the native share sheet (not an error). */
export function isShareCancelled(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/** Copies the link; resolves to whether it worked (no clipboard, permission denied, ... -> false). */
export async function copyProfileLink(profileUrl: string, clipboard: Pick<Clipboard, "writeText"> | undefined): Promise<boolean> {
  if (!profileUrl || !clipboard) return false;
  try {
    await clipboard.writeText(profileUrl);
    return true;
  } catch {
    return false;
  }
}
