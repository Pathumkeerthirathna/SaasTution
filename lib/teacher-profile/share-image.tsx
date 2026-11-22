import { ImageResponse } from "next/og";

import { detectProfilePhotoType } from "@/lib/profile-images/image-signature";
import { parseProfilePhotoKey, PROFILE_PHOTO_MAX_BYTES } from "@/lib/profile-images/storage-keys";
import { teacherProfileUrl } from "@/lib/site-url";
import { openLegacyTeacherPhoto, openProfilePhotoForRead, type OpenedStoredFile } from "@/lib/stored-files/stored-file";
import {
  loadShareSatoriFonts,
  loadSharp,
  needsComplexShaping,
  renderShapedText,
  SHARE_FONT_FAMILY,
  type ShapedText,
} from "@/lib/teacher-profile/share-fonts";
import { SHARE_IMAGE_SIZE, shareImageContent, SITE_NAME, type TeacherShareData } from "@/lib/teacher-profile/share-metadata";

/*
 * Teacher public profile: the 1200 x 630 link-preview image (Open Graph /
 * Twitter), rendered with next/og (ImageResponse, PNG).
 *
 * Built only from PUBLIC share data. The teacher's CURRENT photo is read
 * directly from storage (never fetched over HTTP; no storage path or key
 * appears in the image or the response): a unified-storage photo by its key
 * (which must belong to the teacher), or a legacy /uploads/teachers/ photo by
 * the confined legacy reader. After the signature check, sharp decodes it
 * (JPEG, PNG or WebP), applies the EXIF orientation, crops it square and
 * re-encodes it as a small JPEG. Without sharp, JPEG and PNG are embedded as
 * they are. A missing, unreadable, unsupported or invalid photo is shown as
 * the default teacher avatar (DefaultTeacherAvatar), never as a broken image.
 *
 * Sinhala and Tamil text is drawn shaped (share-fonts.ts renderShapedText)
 * and embedded as a picture of the text; other text is plain image text in
 * Noto Sans (assets/fonts/noto).
 *
 * Shown: photo (large, left), name, designation, qualifications, teaching
 * experience, a Verified badge, the SL Classroom mark and the profile URL.
 * Each piece is optional (share-metadata.ts shareImageContent applies the
 * fallbacks). The page links to this image with a "?v=" content version
 * (share-metadata.ts shareImageVersion), so platform caches refresh when the
 * content changes.
 */

export { SHARE_IMAGE_SIZE };
/** The file-convention default alt; the page's metadata sets a per-teacher alt (shareImageAlt). */
export const SHARE_IMAGE_ALT = "Teacher profile on SL Classroom";
/**
 * Re-generated hourly at most. The URL the page shares is content-versioned,
 * so a change appears in NEW shares immediately; this only bounds how long an
 * already-fetched URL serves its old bytes.
 */
export const SHARE_IMAGE_CACHE_CONTROL = "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400";

const NAVY = "#112D5C";
const NAVY_LIGHT = "#1E4380";
const STEEL = "#4D6C90";
const AMBER = "#D97706";
const INK = "#0F172A";
const MUTED = "#475569";
const TILE = "#EEF3F9";
const GREEN = "#059669";

export type ShareImageInput = TeacherShareData & {
  profileImageUrl: string | null;
  profileImageStorageKey: string | null;
};

// ---- The photo ----------------------------------------------------------------------------------------------

const LEGACY_PREFIX = "/uploads/teachers/";

async function readCapped(file: OpenedStoredFile, max: number): Promise<Uint8Array | null> {
  if (file.size < 1 || file.size > max) {
    await file.stream.cancel().catch(() => undefined);
    return null;
  }
  const reader = file.stream.getReader();
  const out = new Uint8Array(file.size);
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.byteLength > out.length) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    out.set(value, offset);
    offset += value.byteLength;
  }
  return offset === out.length ? out : null;
}

/** Photo pixels embedded (2x the 360 px circle). */
export const SHARE_PHOTO_PIXELS = 720;
/** Decoder guard: a 2 MB file may still declare a huge canvas. */
const PHOTO_MAX_INPUT_PIXELS = 40_000_000;

/**
 * A verified photo's bytes as an embeddable data URL. With sharp: decoded
 * (JPEG / PNG / WebP; the first frame of an animation), EXIF-rotated,
 * centre-cropped to a 720 px square, transparency flattened onto white,
 * re-encoded as JPEG. Without sharp, or if sharp cannot decode it: JPEG / PNG
 * as they are, WebP -> null. Never throws.
 */
export async function normalizeSharePhoto(bytes: Uint8Array, type: "image/jpeg" | "image/png" | "image/webp"): Promise<string | null> {
  const sharp = await loadSharp();
  if (sharp) {
    try {
      const out = await sharp(Buffer.from(bytes), { limitInputPixels: PHOTO_MAX_INPUT_PIXELS, failOn: "error" })
        .rotate()
        .resize(SHARE_PHOTO_PIXELS, SHARE_PHOTO_PIXELS, { fit: "cover", position: "centre" })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 86, mozjpeg: true })
        .toBuffer();
      return `data:image/jpeg;base64,${out.toString("base64")}`;
    } catch {
      // fall through: the original bytes (JPEG / PNG) or the default avatar
    }
  }
  if (type === "image/jpeg" || type === "image/png") return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  return null;
}

/**
 * The photo as a data URL (normalizeSharePhoto), or null for "use the default
 * avatar": no photo, a photo whose removal is pending, an unknown URL form,
 * a key that is not the teacher's, a missing / unreadable file, a type other
 * than JPEG / PNG / WebP, a file that does not pass the image signature
 * check, or a WebP that cannot be decoded. Never throws.
 */
export async function loadShareImagePhoto(input: Pick<ShareImageInput, "profileImageUrl" | "profileImageStorageKey">): Promise<string | null> {
  const url = input.profileImageUrl;
  if (typeof url !== "string" || url === "") return null;
  try {
    let file: OpenedStoredFile | null = null;
    if (input.profileImageStorageKey) {
      // The key comes from the teacher's OWN row (the database CHECK TeacherProfile_profileImageStorageKey_owner
      // ties it to that teacher); it must still be a well-formed photo key before anything is opened.
      if (!parseProfilePhotoKey(input.profileImageStorageKey)) return null;
      file = await openProfilePhotoForRead(input.profileImageStorageKey);
    } else if (url.startsWith(LEGACY_PREFIX)) {
      const name = url.slice(LEGACY_PREFIX.length);
      if (name.includes("/") || name.includes("?") || name.includes("#")) return null;
      file = await openLegacyTeacherPhoto(name);
    } else {
      return null;
    }
    const bytes = await readCapped(file, PROFILE_PHOTO_MAX_BYTES);
    if (!bytes) return null;
    const type = detectProfilePhotoType({ head: bytes.subarray(0, 64), tail: bytes.subarray(Math.max(0, bytes.length - 64)), size: bytes.length });
    if (type !== "image/jpeg" && type !== "image/png" && type !== "image/webp") return null;
    return await normalizeSharePhoto(bytes, type);
  } catch {
    return null;
  }
}

// ---- The default teacher avatar (used whenever there is no usable photo) --------------------------------------

/**
 * A neutral educator illustration in the SL Classroom palette: a person
 * (head and shoulders) wearing a graduation cap, holding an open book. No
 * gender cues; no photograph. Pure SVG, so it renders identically in every
 * preview.
 */
export function DefaultTeacherAvatar({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 240 240" xmlns="http://www.w3.org/2000/svg">
      <circle cx="120" cy="120" r="120" fill="#E8EEF6" />
      <circle cx="120" cy="120" r="104" fill="#DCE5F1" />
      {/* shoulders / gown */}
      <path d="M44 214 C52 162 86 142 120 142 C154 142 188 162 196 214 Z" fill={STEEL} />
      {/* collar */}
      <path d="M100 146 L120 172 L140 146 Z" fill="#FFFFFF" />
      {/* head */}
      <circle cx="120" cy="104" r="34" fill="#F3D9C4" />
      {/* graduation cap: board, crown, tassel */}
      <polygon points="120,48 178,70 120,92 62,70" fill={NAVY} />
      <path d="M92 80 L92 94 C104 102 136 102 148 94 L148 80 L120 91 Z" fill={NAVY} />
      <path d="M170 73 L170 104" stroke={AMBER} strokeWidth="4" strokeLinecap="round" />
      <circle cx="170" cy="108" r="6" fill={AMBER} />
      {/* open book */}
      <path d="M76 178 C92 170 108 170 120 178 L120 210 C108 202 92 202 76 210 Z" fill="#FFFFFF" />
      <path d="M164 178 C148 170 132 170 120 178 L120 210 C132 202 148 202 164 210 Z" fill="#F8FAFC" />
      <path d="M120 178 L120 210" stroke={NAVY} strokeWidth="2.5" />
    </svg>
  );
}

// ---- The composition --------------------------------------------------------------------------------------

/** "slclassroom.live/Pathum-Kumara" (the configured public host; never a storage URL). */
function displayHostAndPath(slug: string): string {
  const url = new URL(teacherProfileUrl(slug));
  return `${url.host}${decodeURIComponent(url.pathname)}`;
}

/** Line icons (Lucide paths, the same icons the app uses), drawn as inline SVG. */
const ICON_PATHS = {
  graduationCap: [
    "M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z",
    "M22 10v6",
    "M6 12.5V16a6 3 0 0 0 12 0v-3.5",
  ],
  award: [
    "m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526",
    "M12 2a6 6 0 1 0 0 12a6 6 0 1 0 0-12z",
  ],
  globe: ["M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z", "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", "M2 12h20"],
  check: ["m9 12 2 2 4-4"],
} as const;

function Icon({ name, size, color, strokeWidth = 2 }: { name: keyof typeof ICON_PATHS; size: number; color: string; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
    >
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** The SL Classroom mark: the graduation cap in a rounded navy tile (as in the app's sidebar), and the name. */
function BrandMark() {
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      <div style={{ width: 52, height: 52, borderRadius: 14, backgroundColor: NAVY, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon name="graduationCap" size={30} color="#FFFFFF" strokeWidth={1.75} />
      </div>
      <div style={{ display: "flex", marginLeft: 14, fontSize: 30, color: NAVY, letterSpacing: 0.3 }}>{SITE_NAME}</div>
    </div>
  );
}

// ---- Text: plain image text, or (Sinhala / Tamil) a shaped picture of it -----------------------------------

/** Pre-rendered shaped text, by element (only for text that needs shaping). */
export type ShapedShareTexts = {
  name?: ShapedText | null;
  designation?: ShapedText | null;
  qualifications?: (ShapedText | null)[];
  description?: ShapedText | null;
  url?: ShapedText | null;
};

// Column widths (px) the text may use: the right column is 1200 - 470 - 56 - 60 = 614 wide.
const TEXT_WIDTH = 614;
const INFO_TEXT_WIDTH = TEXT_WIDTH - 44 - 16;
const URL_TEXT_WIDTH = TEXT_WIDTH - 22 - 10;
const QUALIFICATION_SIZE = 25;
const DESCRIPTION_SIZE = 25;
const URL_SIZE = 22;

function nameFontSize(name: string): number {
  return name.length > 40 ? 44 : name.length > 24 ? 50 : 58;
}
function designationFontSize(designation: string): number {
  return designation.length > 40 ? 26 : 30;
}

/** A line of text: the shaped picture when there is one, else plain text in `style`. */
function TextBlock({ text, shaped, style }: { text: string; shaped?: ShapedText | null; style: React.CSSProperties }) {
  if (shaped) {
    // Only the spacing applies to a picture; and only properties that are SET
    // (the image renderer rejects a style property whose value is undefined).
    const spacing: React.CSSProperties = {};
    for (const key of ["marginTop", "marginBottom", "marginLeft", "marginRight"] as const) {
      if (style[key] !== undefined) spacing[key] = style[key] as never;
    }
    return (
      <div style={{ display: "flex", ...spacing }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={shaped.src} width={shaped.width} height={shaped.height} alt="" style={{ width: shaped.width, height: shaped.height }} />
      </div>
    );
  }
  return <div style={{ display: "flex", ...style }}>{text}</div>;
}

function InfoRow({ icon, lines, shaped }: { icon: keyof typeof ICON_PATHS; lines: string[]; shaped?: (ShapedText | null)[] }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", marginTop: 16 }}>
      <div style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: TILE, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon name={icon} size={24} color={STEEL} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginLeft: 16, paddingTop: 6, flex: 1 }}>
        {lines.map((line, i) => (
          <TextBlock
            key={i}
            text={line}
            shaped={shaped?.[i]}
            style={{ fontSize: QUALIFICATION_SIZE, color: INK, lineHeight: 1.3, marginTop: i === 0 ? 0 : 4 }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Shaped pictures of every Sinhala / Tamil text on the image (sizes and
 * widths as in the layout). Latin-only text is left out (plain text). Each
 * entry is null when shaping failed (that text then falls back to plain
 * text). Never throws.
 */
export async function shapeShareTexts(data: ShareImageInput): Promise<ShapedShareTexts> {
  const content = shareImageContent(data);
  const shape = (text: string, sizePx: number, color: string, maxWidth: number) =>
    needsComplexShaping(text) ? renderShapedText({ text, sizePx, color, maxWidth }) : Promise.resolve(undefined);
  const url = displayHostAndPath(data.slug);
  const [name, designation, description, urlText, ...qualifications] = await Promise.all([
    shape(content.name, nameFontSize(content.name), INK, TEXT_WIDTH),
    shape(content.designation, designationFontSize(content.designation), AMBER, TEXT_WIDTH),
    shape(content.description, DESCRIPTION_SIZE, MUTED, TEXT_WIDTH),
    shape(url, URL_SIZE, STEEL, URL_TEXT_WIDTH),
    ...content.qualifications.map((q) => shape(q, QUALIFICATION_SIZE, INK, INFO_TEXT_WIDTH)),
  ]);
  const out: ShapedShareTexts = {};
  if (name !== undefined) out.name = name;
  if (designation !== undefined) out.designation = designation;
  if (description !== undefined) out.description = description;
  if (urlText !== undefined) out.url = urlText;
  if (qualifications.some((q) => q !== undefined)) out.qualifications = qualifications.map((q) => q ?? null);
  return out;
}

const PHOTO = 360;
const RING = 12;

/** The preview's elements (exported for tests). */
export function ShareImageMarkup({ data, photo, shaped = {} }: { data: ShareImageInput; photo: string | null; shaped?: ShapedShareTexts }) {
  const content = shareImageContent(data);
  const nameSize = nameFontSize(content.name);
  const designationSize = designationFontSize(content.designation);
  const hasDetails = content.qualifications.length > 0 || Boolean(content.experience) || Boolean(content.description);

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", backgroundColor: "#FFFFFF", fontFamily: SHARE_FONT_FAMILY }}>
      {/* Left: the teacher's photo (or the default avatar), large, on the brand navy */}
      <div
        style={{
          width: 470,
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          overflow: "hidden",
          backgroundImage: `linear-gradient(160deg, ${NAVY} 0%, ${NAVY_LIGHT} 100%)`,
        }}
      >
        {/* soft decorative circles */}
        <div style={{ position: "absolute", top: -120, left: -110, width: 340, height: 340, borderRadius: 9999, backgroundColor: "rgba(255,255,255,0.06)" }} />
        <div style={{ position: "absolute", bottom: -140, right: -120, width: 380, height: 380, borderRadius: 9999, backgroundColor: "rgba(255,255,255,0.05)" }} />
        <div style={{ position: "absolute", top: 0, right: 0, width: 8, height: "100%", backgroundColor: AMBER }} />

        <div
          style={{
            width: PHOTO + RING * 2,
            height: PHOTO + RING * 2,
            borderRadius: 9999,
            backgroundColor: "#FFFFFF",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            boxShadow: "0 22px 48px rgba(0,0,0,0.30)",
          }}
        >
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo} width={PHOTO} height={PHOTO} alt="" style={{ width: PHOTO, height: PHOTO, borderRadius: 9999, objectFit: "cover" }} />
          ) : (
            <DefaultTeacherAvatar size={PHOTO} />
          )}
          {content.verified ? (
            <div
              style={{
                position: "absolute",
                right: 18,
                bottom: 18,
                width: 64,
                height: 64,
                borderRadius: 9999,
                backgroundColor: GREEN,
                border: "6px solid #FFFFFF",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="check" size={40} color="#FFFFFF" strokeWidth={3} />
            </div>
          ) : null}
        </div>
      </div>

      {/* Right: brand, name, designation, qualifications, experience, link */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "48px 60px 40px 56px" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <BrandMark />
          <div
            style={{
              display: "flex",
              marginLeft: "auto",
              padding: "6px 16px",
              borderRadius: 9999,
              backgroundColor: content.verified ? "#ECFDF5" : TILE,
              color: content.verified ? GREEN : STEEL,
              fontSize: 19,
            }}
          >
            {content.verified ? "Verified Teacher" : "Teacher Profile"}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center", overflow: "hidden", padding: "12px 0 16px 0" }}>
          <TextBlock text={content.name} shaped={shaped.name} style={{ fontSize: nameSize, color: INK, lineHeight: 1.1, letterSpacing: -0.5 }} />
          {content.designation ? (
            <TextBlock text={content.designation} shaped={shaped.designation} style={{ marginTop: 10, fontSize: designationSize, color: AMBER, lineHeight: 1.2 }} />
          ) : null}
          {hasDetails ? <div style={{ display: "flex", width: 88, height: 5, borderRadius: 3, backgroundColor: NAVY, marginTop: 20, marginBottom: 4 }} /> : null}
          {content.qualifications.length > 0 ? <InfoRow icon="graduationCap" lines={content.qualifications} shaped={shaped.qualifications} /> : null}
          {content.experience ? <InfoRow icon="award" lines={[content.experience]} /> : null}
          {content.description ? (
            shaped.description ? (
              <TextBlock text={content.description} shaped={shaped.description} style={{ marginTop: 18 }} />
            ) : (
              <div style={{ display: "flex", marginTop: 18, fontSize: DESCRIPTION_SIZE, color: MUTED, lineHeight: 1.4, maxHeight: 108, overflow: "hidden" }}>
                {content.description}
              </div>
            )
          ) : null}
        </div>

        <div style={{ display: "flex", alignItems: "center", borderTop: "2px solid #E2E8F0", paddingTop: 16, fontSize: URL_SIZE, color: STEEL }}>
          <Icon name="globe" size={22} color={STEEL} />
          <TextBlock text={displayHostAndPath(data.slug)} shaped={shaped.url} style={{ marginLeft: 10 }} />
        </div>
      </div>
    </div>
  );
}

/** Renders the composition to PNG bytes (eagerly, so a failure is caught here and not mid-response). */
export type ShareImageRenderer = (element: React.ReactElement) => Promise<ArrayBuffer>;

/** next/og with the Noto fonts (Latin + Sinhala + Tamil glyphs); its built-in Latin font if they cannot be read. */
const renderWithNextOg: ShareImageRenderer = async (element) => {
  const fonts = await loadShareSatoriFonts();
  return new ImageResponse(element, { ...SHARE_IMAGE_SIZE, ...(fonts ? { fonts } : {}) }).arrayBuffer();
};

/**
 * The PNG preview for a PUBLIC profile's share data. If the render fails with
 * the photo or shaped text pictures embedded (e.g. a photo the renderer
 * cannot decode), it is rendered once more with the default avatar and plain
 * text (never a broken image or a failed preview). A failure of that plain
 * render is a genuine error.
 */
export async function renderTeacherShareImage(
  data: ShareImageInput,
  options: { render?: ShareImageRenderer; loadPhoto?: typeof loadShareImagePhoto; shapeTexts?: typeof shapeShareTexts } = {}
): Promise<Response> {
  const render = options.render ?? renderWithNextOg;
  const [photo, shaped] = await Promise.all([(options.loadPhoto ?? loadShareImagePhoto)(data), (options.shapeTexts ?? shapeShareTexts)(data)]);
  let png: ArrayBuffer;
  try {
    png = await render(<ShareImageMarkup data={data} photo={photo} shaped={shaped} />);
  } catch (error) {
    if (photo === null && Object.keys(shaped).length === 0) throw error;
    png = await render(<ShareImageMarkup data={data} photo={null} />);
  }
  return new Response(png, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": SHARE_IMAGE_CACHE_CONTROL, "X-Content-Type-Options": "nosniff" },
  });
}
