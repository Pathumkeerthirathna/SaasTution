/*
 * Teacher profile sharing (the Share button and dialog in
 * TeacherProfileHeader). Pure helpers: the share-target links for ONE profile
 * URL (lib/site-url.ts teacherProfileUrl, built from the CURRENT slug), the
 * native Web Share payload, and copying with a reported outcome. No
 * Messenger link: Facebook's "send" dialog requires an app id this project
 * does not have, so it cannot work.
 */

export type ProfileShareLinks = {
  whatsapp: string;
  telegram: string;
  facebook: string;
  linkedin: string;
  x: string;
  email: string;
};

export function profileShareMessage(name: string): string {
  const who = name.trim() || "this teacher";
  return `View ${who}'s teacher profile on SL Classroom`;
}

/** Every share target for one profile URL (all values encoded). Empty strings when there is no URL. */
export function buildProfileShareLinks(profileUrl: string, name: string): ProfileShareLinks {
  if (!profileUrl) return { whatsapp: "", telegram: "", facebook: "", linkedin: "", x: "", email: "" };
  const url = encodeURIComponent(profileUrl);
  const message = profileShareMessage(name);
  return {
    whatsapp: `https://wa.me/?text=${encodeURIComponent(`${message}: ${profileUrl}`)}`,
    telegram: `https://t.me/share/url?url=${url}&text=${encodeURIComponent(message)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${url}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
    x: `https://twitter.com/intent/tweet?url=${url}&text=${encodeURIComponent(message)}`,
    email: `mailto:?subject=${encodeURIComponent(`${name.trim() || "Teacher"} – SL Classroom teacher profile`)}&body=${encodeURIComponent(`${message}: ${profileUrl}`)}`,
  };
}

/** The native share sheet's payload (Web Share API). */
export function nativeSharePayload(profileUrl: string, name: string): ShareData {
  return { title: `${name.trim() || "Teacher profile"} | SL Classroom`, text: profileShareMessage(name), url: profileUrl };
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
