import { ImageResponse } from "next/og";

import { detectProfilePhotoType } from "@/lib/profile-images/image-signature";
import { parseProfilePhotoKey, PROFILE_PHOTO_MAX_BYTES } from "@/lib/profile-images/storage-keys";
import { openLegacyTeacherPhoto, openProfilePhotoForRead, type OpenedStoredFile } from "@/lib/stored-files/stored-file";
import { loadSharp } from "@/lib/teacher-profile/share-fonts";
import { SHARE_IMAGE_SIZE, type TeacherShareData } from "@/lib/teacher-profile/share-metadata";

/*
 * Teacher public profile: the link-preview image (Open Graph / Twitter).
 *
 * It is the teacher's PHOTO and nothing else: no text, logo, card or
 * background. The teacher's details travel as the preview's title and
 * description (share-metadata.ts), which WhatsApp, Facebook and Telegram show
 * beside / under the image.
 *
 * Built only from PUBLIC share data. The CURRENT photo is read directly from
 * storage (never fetched over HTTP; no storage path or key appears in the
 * response): a unified-storage photo by its key (which must belong to the
 * teacher), or a legacy /uploads/teachers/ photo by the confined legacy
 * reader, and only after the image signature check.
 *
 * The photo keeps its orientation: portrait stays portrait, landscape stays
 * landscape. Only extreme proportions are trimmed (to 3:4 at the tallest and
 * 1.91:1 at the widest, the range previews display without cropping it
 * themselves), around the most salient region (libvips "attention": skin
 * tones and detail, so the face stays in frame). EXIF orientation is applied,
 * the long side is at most 1200 px (small photos are enlarged to 600 px so
 * platforms accept them), transparency is flattened onto white, and it is
 * sent as a JPEG of at most ~300 KB (WhatsApp skips larger preview images).
 *
 * No usable photo (none, removal pending, missing, unreadable, invalid, or a
 * WebP without sharp): the default teacher avatar on its own (PNG).
 */

export { SHARE_IMAGE_SIZE };
/** The file-convention default alt; the page's metadata sets a per-teacher alt (shareImageAlt). */
export const SHARE_IMAGE_ALT = "Teacher profile photo on SL Classroom";
/**
 * Re-generated hourly at most. The URL the page shares is versioned by the
 * photo, so a new photo appears in NEW shares immediately; this only bounds
 * how long an already-fetched URL serves its old bytes.
 */
export const SHARE_IMAGE_CACHE_CONTROL = "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400";

export type ShareImageInput = TeacherShareData & {
  profileImageUrl: string | null;
  profileImageStorageKey: string | null;
};

/** The longest side of the shared photo (px). */
export const SHARE_PHOTO_MAX_SIDE = 1200;
/** Smaller photos are enlarged to this longest side (px). */
export const SHARE_PHOTO_MIN_SIDE = 600;
/** Width / height limits: 3:4 (tallest; the usual phone portrait is kept whole) to 1.91:1 (widest). */
export const SHARE_PHOTO_RATIO = { min: 3 / 4, max: 1.91 } as const;
/** Preview images above this size are skipped by WhatsApp. */
export const SHARE_PHOTO_MAX_BYTES = 300_000;
/** The default avatar image's side (px). */
export const SHARE_AVATAR_SIDE = 630;
/** Decoder guard: a 2 MB file may still declare a huge canvas. */
const PHOTO_MAX_INPUT_PIXELS = 40_000_000;
const JPEG_QUALITIES = [82, 72, 62, 52] as const;

export type SharePhotoType = "image/jpeg" | "image/png" | "image/webp";
export type StoredSharePhoto = { bytes: Uint8Array; type: SharePhotoType };
export type ShareImageBody = { body: Uint8Array; contentType: string };

// ---- The stored photo -------------------------------------------------------------------------------------

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
 * The teacher's CURRENT photo bytes and verified type, or null: no photo, a
 * photo whose removal is pending, an unknown URL form, a key that is not
 * well-formed, a missing / unreadable file, a type other than JPEG / PNG /
 * WebP, or a file that does not pass the image signature check. Never throws.
 */
export async function loadSharePhoto(input: Pick<ShareImageInput, "profileImageUrl" | "profileImageStorageKey">): Promise<StoredSharePhoto | null> {
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
    return { bytes, type };
  } catch {
    return null;
  }
}

// ---- The shared photo ---------------------------------------------------------------------------------------

/**
 * The output size for an (EXIF-oriented) photo of width x height: the same
 * proportions, trimmed only when outside SHARE_PHOTO_RATIO, with the long
 * side scaled into [SHARE_PHOTO_MIN_SIDE, SHARE_PHOTO_MAX_SIDE]. Pure.
 */
export function sharePhotoSize(width: number, height: number): { width: number; height: number } {
  const ratio = Math.min(Math.max(width / height, SHARE_PHOTO_RATIO.min), SHARE_PHOTO_RATIO.max);
  // The largest box of that ratio inside the photo.
  let w = width;
  let h = height;
  if (width / height > ratio) w = height * ratio;
  else if (width / height < ratio) h = width / ratio;
  const long = Math.max(w, h);
  const scale = long > SHARE_PHOTO_MAX_SIDE ? SHARE_PHOTO_MAX_SIDE / long : long < SHARE_PHOTO_MIN_SIDE ? SHARE_PHOTO_MIN_SIDE / long : 1;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * The photo as the preview image (JPEG; see the header comment). Without
 * sharp, or if sharp cannot process it: a JPEG / PNG is sent as it is stored,
 * a WebP gives null (default avatar). Never throws.
 */
export async function sharePhotoImage(photo: StoredSharePhoto): Promise<ShareImageBody | null> {
  const sharp = await loadSharp();
  if (sharp) {
    try {
      const input = Buffer.from(photo.bytes);
      const options = { limitInputPixels: PHOTO_MAX_INPUT_PIXELS, failOn: "error" } as const;
      const meta = await sharp(input, options).metadata();
      if (!meta.width || !meta.height) throw new Error("no dimensions");
      // EXIF orientations 5-8 swap width and height.
      const turned = typeof meta.orientation === "number" && meta.orientation >= 5;
      const size = sharePhotoSize(turned ? meta.height : meta.width, turned ? meta.width : meta.height);
      let out: Buffer | null = null;
      for (const quality of JPEG_QUALITIES) {
        out = await sharp(input, options)
          .rotate()
          .resize(size.width, size.height, { fit: "cover", position: "attention" })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality, mozjpeg: true })
          .toBuffer();
        if (out.length <= SHARE_PHOTO_MAX_BYTES) break;
      }
      if (out) return { body: new Uint8Array(out), contentType: "image/jpeg" };
    } catch {
      // fall through: the stored bytes (JPEG / PNG) or the default avatar
    }
  }
  if (photo.type === "image/jpeg" || photo.type === "image/png") return { body: photo.bytes, contentType: photo.type };
  return null;
}

// ---- The default teacher avatar (used whenever there is no usable photo) --------------------------------------

/**
 * A neutral educator illustration in the SL Classroom palette (a person,
 * head and shoulders, wearing a graduation cap and holding an open book; no
 * gender cues; no photograph), as SVG on its own light square.
 */
export function defaultTeacherAvatarSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 240 240">
  <rect width="240" height="240" fill="#E8EEF6"/>
  <circle cx="120" cy="120" r="104" fill="#DCE5F1"/>
  <path d="M44 214 C52 162 86 142 120 142 C154 142 188 162 196 214 Z" fill="#4D6C90"/>
  <path d="M100 146 L120 172 L140 146 Z" fill="#FFFFFF"/>
  <circle cx="120" cy="104" r="34" fill="#F3D9C4"/>
  <polygon points="120,48 178,70 120,92 62,70" fill="#112D5C"/>
  <path d="M92 80 L92 94 C104 102 136 102 148 94 L148 80 L120 91 Z" fill="#112D5C"/>
  <path d="M170 73 L170 104" stroke="#D97706" stroke-width="4" stroke-linecap="round"/>
  <circle cx="170" cy="108" r="6" fill="#D97706"/>
  <path d="M76 178 C92 170 108 170 120 178 L120 210 C108 202 92 202 76 210 Z" fill="#FFFFFF"/>
  <path d="M164 178 C148 170 132 170 120 178 L120 210 C132 202 148 202 164 210 Z" fill="#F8FAFC"/>
  <path d="M120 178 L120 210" stroke="#112D5C" stroke-width="2.5"/>
</svg>`;
}

/** The default avatar alone, as a square PNG (sharp; next/og if sharp is unavailable). */
export async function defaultAvatarImage(): Promise<ShareImageBody> {
  const svg = defaultTeacherAvatarSvg(SHARE_AVATAR_SIDE);
  const sharp = await loadSharp();
  if (sharp) {
    try {
      return { body: new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer()), contentType: "image/png" };
    } catch {
      // fall through to next/og
    }
  }
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const png = await new ImageResponse(
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} width={SHARE_AVATAR_SIDE} height={SHARE_AVATAR_SIDE} alt="" />,
    { width: SHARE_AVATAR_SIDE, height: SHARE_AVATAR_SIDE }
  ).arrayBuffer();
  return { body: new Uint8Array(png), contentType: "image/png" };
}

// ---- The response -----------------------------------------------------------------------------------------

/**
 * The preview image for a PUBLIC profile's share data: the teacher's photo,
 * or the default avatar when there is no usable photo. The photo is read and
 * produced eagerly, so a failure is handled here (avatar), never mid-response.
 */
export async function renderTeacherShareImage(
  data: ShareImageInput,
  options: {
    loadPhoto?: typeof loadSharePhoto;
    photoImage?: typeof sharePhotoImage;
    avatarImage?: typeof defaultAvatarImage;
  } = {}
): Promise<Response> {
  const photo = await (options.loadPhoto ?? loadSharePhoto)(data);
  const image = (photo ? await (options.photoImage ?? sharePhotoImage)(photo) : null) ?? (await (options.avatarImage ?? defaultAvatarImage)());
  const body = image.body.buffer.slice(image.body.byteOffset, image.body.byteOffset + image.body.byteLength) as ArrayBuffer;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": image.contentType, "Cache-Control": SHARE_IMAGE_CACHE_CONTROL, "X-Content-Type-Options": "nosniff" },
  });
}
