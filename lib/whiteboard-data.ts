import { AppError } from "@/lib/error-handler";
import type { WhiteboardElement, WhiteboardScene } from "@/types/whiteboard";

/** Upper bound for one whiteboard document (saved or live), in bytes of JSON. */
export const MAX_WHITEBOARD_BYTES = 5 * 1024 * 1024;

const MAX_WHITEBOARD_ELEMENTS = 20_000;

function isElement(value: unknown): value is WhiteboardElement {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/**
 * Normalises an untrusted scene before it is stored or broadcast:
 *  - only plain elements are kept,
 *  - deleted elements are dropped,
 *  - image elements are dropped, so no embedded/base64 image data is ever kept,
 *  - the total size is capped.
 */
export function sanitizeWhiteboardScene(input: unknown): WhiteboardScene {
  const raw = (input ?? {}) as { elements?: unknown; viewBackgroundColor?: unknown };

  if (!Array.isArray(raw.elements)) {
    throw new AppError("Whiteboard data must contain an elements list.", 400, "VALIDATION_ERROR");
  }

  if (raw.elements.length > MAX_WHITEBOARD_ELEMENTS) {
    throw new AppError("This whiteboard has too many elements to save.", 400, "WHITEBOARD_TOO_LARGE");
  }

  const elements = raw.elements
    .filter(isElement)
    .filter((element) => element.isDeleted !== true && element.type !== "image")
    .map((element) => {
      // Nothing may keep pointing at an embedded file, since files are never stored.
      const copy: WhiteboardElement = { ...element };
      delete copy.fileId;
      return copy;
    });

  const scene: WhiteboardScene = {
    elements,
    ...(typeof raw.viewBackgroundColor === "string" && raw.viewBackgroundColor.length <= 32
      ? { viewBackgroundColor: raw.viewBackgroundColor }
      : {}),
  };

  if (Buffer.byteLength(JSON.stringify(scene), "utf8") > MAX_WHITEBOARD_BYTES) {
    throw new AppError("This whiteboard is too large to save (limit 5 MB).", 413, "WHITEBOARD_TOO_LARGE");
  }

  return scene;
}
