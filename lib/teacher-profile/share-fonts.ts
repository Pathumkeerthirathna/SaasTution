import { readFile } from "node:fs/promises";
import path from "node:path";

/*
 * Teacher profile share image: fonts, and correctly SHAPED Sinhala / Tamil text.
 *
 * The image layout is drawn by next/og (satori), which has no OpenType
 * shaping: Sinhala and Tamil come out wrong (pre-base vowel signs on the
 * wrong side, broken conjuncts and ZWJ forms). So any text containing those
 * scripts is drawn by pango + HarfBuzz through sharp (the same Noto font
 * files) into a transparent PNG of exactly the text's size, and the layout
 * embeds that picture in place of the text. Latin text stays plain satori text.
 *
 * Fonts: assets/fonts/noto (SIL OFL 1.1, see its README), read from
 * <cwd>/assets/fonts/noto - no system fonts are needed.
 *
 * Everything here degrades instead of failing: no sharp, a missing font file
 * or a pango error gives null, and the caller falls back to plain satori text
 * (with the Sinhala / Tamil fonts loaded, so glyphs still show, unshaped).
 */

export const SHARE_FONT_DIR = path.join(process.cwd(), "assets", "fonts", "noto");
export const SHARE_FONT_FAMILY = "Noto Sans, Noto Sans Sinhala, Noto Sans Tamil";

const FONT_FILES = [
  { name: "Noto Sans", file: "NotoSans-Regular.ttf" },
  { name: "Noto Sans Sinhala", file: "NotoSansSinhala-Regular.ttf" },
  { name: "Noto Sans Tamil", file: "NotoSansTamil-Regular.ttf" },
] as const;

// Sinhala U+0D80-U+0DFF, Tamil U+0B80-U+0BFF (built from code points so the ranges stay exact).
const COMPLEX_SCRIPT = new RegExp(
  `[${String.fromCharCode(0x0d80)}-${String.fromCharCode(0x0dff)}${String.fromCharCode(0x0b80)}-${String.fromCharCode(0x0bff)}]`
);

/** True when the text contains Sinhala or Tamil (needs shaping). */
export function needsComplexShaping(text: string | null | undefined): boolean {
  return typeof text === "string" && COMPLEX_SCRIPT.test(text);
}

// ---- satori fonts ------------------------------------------------------------------------------------------

export type SatoriFont = { name: string; data: ArrayBuffer; weight: 400; style: "normal" };

let satoriFonts: Promise<SatoriFont[] | null> | null = null;

/**
 * The three Noto fonts for ImageResponse({ fonts }) (once per process). null
 * if any file is unreadable: next/og then uses its built-in Latin font.
 */
export function loadShareSatoriFonts(): Promise<SatoriFont[] | null> {
  satoriFonts ??= Promise.all(
    FONT_FILES.map(async ({ name, file }) => {
      const buf = await readFile(path.join(SHARE_FONT_DIR, file));
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      return { name, data, weight: 400 as const, style: "normal" as const };
    })
  ).catch(() => null);
  return satoriFonts;
}

// ---- sharp (loaded lazily; optional at runtime) -------------------------------------------------------------

type SharpModule = typeof import("sharp").default;
let sharpModule: Promise<SharpModule | null> | null = null;

/** The sharp function, or null when it is not installed / cannot load its native binary. */
export function loadSharp(): Promise<SharpModule | null> {
  sharpModule ??= import("sharp")
    .then((mod) => (typeof mod.default === "function" ? mod.default : null))
    .catch(() => null);
  return sharpModule;
}

let pangoFonts: Promise<boolean> | null = null;

/**
 * Registers the three font files with pango (fontconfig application fonts;
 * libvips registers each file once per process). False when that fails.
 */
function registerPangoFonts(sharp: SharpModule): Promise<boolean> {
  pangoFonts ??= (async () => {
    for (const { name, file } of FONT_FILES) {
      await sharp({ text: { text: "a", font: `${name} 8`, fontfile: path.join(SHARE_FONT_DIR, file), dpi: 72 } }).png().toBuffer();
    }
    return true;
  })().catch(() => {
    pangoFonts = null; // retried by the next request
    return false;
  });
  return pangoFonts;
}

// ---- shaped text ------------------------------------------------------------------------------------------

export type ShapedText = { src: string; width: number; height: number };

function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * The text drawn by pango (HarfBuzz shaping), wrapped at `maxWidth` pixels,
 * as a transparent PNG data URL with its pixel size; null on any failure.
 * `sizePx` is the font size in pixels (pango points at 72 dpi).
 */
export async function renderShapedText(input: { text: string; sizePx: number; color: string; maxWidth: number }): Promise<ShapedText | null> {
  const { text, sizePx, color, maxWidth } = input;
  if (!text || !/^#[0-9a-fA-F]{6}$/.test(color)) return null;
  try {
    const sharp = await loadSharp();
    if (!sharp || !(await registerPangoFonts(sharp))) return null;
    // Tamil's own line box is short (~0.9 em): a little transparent padding and
    // line spacing keep the gaps close to the plain-text lines around it.
    const pad = Math.round(sizePx * 0.12);
    const { data, info } = await sharp({
      text: {
        text: `<span foreground="${color}">${escapeMarkup(text)}</span>`,
        font: `${SHARE_FONT_FAMILY} ${Math.round(sizePx)}`,
        dpi: 72,
        rgba: true,
        width: Math.round(maxWidth),
        wrap: "word-char",
        spacing: Math.round(sizePx * 0.15),
      },
    })
      .extend({ top: pad, bottom: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height) return null;
    return { src: `data:image/png;base64,${data.toString("base64")}`, width: info.width, height: info.height };
  } catch {
    return null;
  }
}
