/*
 * Teacher profile sharing: the human-readable details (pure, dependency-free;
 * used by both the link-preview metadata on the server and the Share button
 * in the browser, so both always say the same thing).
 *
 * Only PUBLIC profile data goes in: the formatted name, the designation, the
 * HIGHEST qualification (the one the public profile header shows), the years
 * of experience and the phone / WhatsApp numbers the profile shows publicly.
 * Never an email address, and never any other qualification.
 */

export type TeacherShareDetails = {
  /** e.g. "Mr. Pathum Kumara". */
  name: string;
  designation?: string | null;
  /** The highest qualification only. */
  qualification?: string | null;
  yearsOfExperience?: number | null;
  phone?: string | null;
  whatsapp?: string | null;
};

/** One line of plain text: whitespace (including line breaks) collapsed. */
export function shareLine(value: string | null | undefined): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** "8 years of teaching experience" / "1 year of teaching experience"; "" when not set, 0 or not a sensible whole number. */
export function teachingExperienceText(years: number | null | undefined): string {
  if (typeof years !== "number" || !Number.isInteger(years) || years < 1 || years > 99) return "";
  return `${years} ${years === 1 ? "year" : "years"} of teaching experience`;
}

/** "Mr. Pathum Kumara | IT Teacher | SL Classroom" (the designation only when set). */
export function teacherShareHeading(details: Pick<TeacherShareDetails, "name" | "designation">, siteName = "SL Classroom"): string {
  return [shareLine(details.name) || "Teacher profile", shareLine(details.designation), siteName].filter(Boolean).join(" | ");
}

/**
 * The detail lines, each present only when there is something to say:
 *   Bachelor of Science in Information Technology
 *   8 years of teaching experience
 *   Contact: 0711455219
 *   WhatsApp: 0778112543
 *   View teacher profile: slclassroom.live/pathum
 */
export function teacherShareDetailLines(details: TeacherShareDetails, profileLink: string): string[] {
  const phone = shareLine(details.phone);
  const whatsapp = shareLine(details.whatsapp);
  const link = shareLine(profileLink);
  return [
    shareLine(details.qualification),
    teachingExperienceText(details.yearsOfExperience),
    phone ? `Contact: ${phone}` : "",
    whatsapp ? `WhatsApp: ${whatsapp}` : "",
    link ? `View teacher profile: ${link}` : "",
  ].filter(Boolean);
}

/** "slclassroom.live/pathum" for "https://slclassroom.live/pathum" (the readable form of a profile URL). */
export function readableProfileLink(profileUrl: string): string {
  try {
    const url = new URL(profileUrl);
    return `${url.host}${decodeURIComponent(url.pathname)}`;
  } catch {
    return shareLine(profileUrl);
  }
}
