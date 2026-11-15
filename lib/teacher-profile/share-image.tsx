import { ImageResponse } from "next/og";

import { detectProfilePhotoType } from "@/lib/profile-images/image-signature";
import { parseProfilePhotoKey, PROFILE_PHOTO_MAX_BYTES } from "@/lib/profile-images/storage-keys";
import { teacherProfileUrl } from "@/lib/site-url";
import { openLegacyTeacherPhoto, openProfilePhotoForRead, type OpenedStoredFile } from "@/lib/stored-files/stored-file";
import { sanitizeShareText, SITE_NAME } from "@/lib/teacher-profile/share-metadata";

/*
 * Teacher public profile: the 1200 x 630 link-preview image (Open Graph /
 * Twitter), rendered with next/og (ImageResponse, PNG).
 *
 * Built only from PUBLIC share data. The teacher's CURRENT photo is read
 * directly from storage (never fetched over HTTP; no storage path or key
 * appears in the image or the response): a unified-storage photo by its key
 * (which must belong to the teacher), or a legacy /uploads/teachers/ photo by
 * the confined legacy reader. JPEG and PNG are embedded (as data URLs).
 * WebP is not supported by the image renderer, so a WebP photo - like a
 * missing, unreadable, unsupported or invalid one - is shown as the default
 * teacher avatar (DefaultTeacherAvatar), never as a broken or empty image.
 */

export const SHARE_IMAGE_SIZE = { width: 1200, height: 630 } as const;
export const SHARE_IMAGE_ALT = "Teacher profile on SL Classroom";
/** Previews are re-generated hourly at most (a changed photo shows up without a deploy). */
export const SHARE_IMAGE_CACHE_CONTROL = "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400";

const NAVY = "#112D5C";
const STEEL = "#4D6C90";
const AMBER = "#D97706";
const INK = "#0F172A";
const MUTED = "#475569";

export type ShareImageInput = {
  slug: string;
  name: string;
  designation: string | null;
  headline: string | null;
  aboutMe: string | null;
  seoDescription: string | null;
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

/**
 * The photo as a data URL (JPEG / PNG only), or null for "use the default
 * avatar": no photo, a photo whose removal is pending, an unknown URL form,
 * a key that is not the teacher's, a missing / unreadable file, a WebP or
 * any other type, or a file that does not pass the image signature check.
 * Never throws.
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
    if (type !== "image/jpeg" && type !== "image/png") return null;
    return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
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

function displayHostAndPath(slug: string): string {
  const url = new URL(teacherProfileUrl(slug));
  return `${url.host}${decodeURIComponent(url.pathname)}`;
}

/** The preview's elements (exported for tests). */
export function ShareImageMarkup({ data, photo }: { data: ShareImageInput; photo: string | null }) {
  const name = sanitizeShareText(data.name, 60) || "SL Classroom Teacher";
  const designation = sanitizeShareText(data.designation, 60);
  const description = sanitizeShareText(data.seoDescription || data.headline || data.aboutMe, 150);
  const nameSize = name.length > 40 ? 46 : name.length > 26 ? 54 : 62;

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", backgroundColor: "#FFFFFF", fontFamily: "Noto Sans" }}>
      {/* Left: photo (or the default avatar) on the brand navy */}
      <div
        style={{
          width: 440,
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundImage: `linear-gradient(160deg, ${NAVY} 0%, #1E4380 100%)`,
        }}
      >
        <div
          style={{
            width: 312,
            height: 312,
            borderRadius: 9999,
            backgroundColor: "#FFFFFF",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 18px 40px rgba(0,0,0,0.25)",
          }}
        >
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo} width={292} height={292} alt="" style={{ width: 292, height: 292, borderRadius: 9999, objectFit: "cover" }} />
          ) : (
            <DefaultTeacherAvatar size={292} />
          )}
        </div>
      </div>

      {/* Right: brand, name, designation, description, link */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "56px 64px 48px 64px" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              backgroundColor: NAVY,
              color: "#FFFFFF",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              letterSpacing: 1,
            }}
          >
            SL
          </div>
          <div style={{ display: "flex", marginLeft: 14, fontSize: 28, color: NAVY, letterSpacing: 0.5 }}>{SITE_NAME}</div>
          <div
            style={{
              display: "flex",
              marginLeft: "auto",
              padding: "6px 16px",
              borderRadius: 9999,
              backgroundColor: "#EEF3F9",
              color: STEEL,
              fontSize: 20,
            }}
          >
            Teacher Profile
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
          <div style={{ display: "flex", fontSize: nameSize, color: INK, lineHeight: 1.12, letterSpacing: -0.5 }}>{name}</div>
          {designation ? <div style={{ display: "flex", marginTop: 14, fontSize: 32, color: AMBER }}>{designation}</div> : null}
          <div style={{ display: "flex", width: 96, height: 5, borderRadius: 3, backgroundColor: NAVY, marginTop: 26, marginBottom: 22 }} />
          {description ? (
            <div style={{ display: "flex", fontSize: 26, color: MUTED, lineHeight: 1.4, maxHeight: 112, overflow: "hidden" }}>{description}</div>
          ) : null}
        </div>

        <div style={{ display: "flex", alignItems: "center", borderTop: "2px solid #E2E8F0", paddingTop: 18, fontSize: 22, color: STEEL }}>
          {displayHostAndPath(data.slug)}
        </div>
      </div>
    </div>
  );
}

/** Renders the composition to PNG bytes (eagerly, so a failure is caught here and not mid-response). */
export type ShareImageRenderer = (element: React.ReactElement) => Promise<ArrayBuffer>;

const renderWithNextOg: ShareImageRenderer = (element) => new ImageResponse(element, { ...SHARE_IMAGE_SIZE }).arrayBuffer();

/**
 * The PNG preview for a PUBLIC profile's share data. If the teacher's photo
 * passes the signature check but cannot be decoded by the renderer, the image
 * is rendered again with the default teacher avatar (never a broken image or
 * a failed preview). Without a photo, a render failure is a genuine error.
 */
export async function renderTeacherShareImage(
  data: ShareImageInput,
  options: { render?: ShareImageRenderer; loadPhoto?: typeof loadShareImagePhoto } = {}
): Promise<Response> {
  const render = options.render ?? renderWithNextOg;
  const photo = await (options.loadPhoto ?? loadShareImagePhoto)(data);
  let png: ArrayBuffer;
  try {
    png = await render(<ShareImageMarkup data={data} photo={photo} />);
  } catch (error) {
    if (photo === null) throw error;
    png = await render(<ShareImageMarkup data={data} photo={null} />);
  }
  return new Response(png, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": SHARE_IMAGE_CACHE_CONTROL, "X-Content-Type-Options": "nosniff" },
  });
}
