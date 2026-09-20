import type { WhiteboardElement, WhiteboardScene } from "@/types/whiteboard";

export const EMPTY_SCENE: WhiteboardScene = { elements: [] };

/**
 * Cheap fingerprint of a scene's elements, used to tell "the drawing changed"
 * from "only the viewport moved" and to work out whether there are unsaved edits.
 */
export function sceneSignature(scene: WhiteboardScene): string {
  const elements = scene.elements;
  let versionSum = 0;

  for (const element of elements) {
    versionSum += typeof element.version === "number" ? element.version : 0;
  }

  const last: WhiteboardElement | undefined = elements[elements.length - 1];

  // A scene without a background colour is the same as the default white one; the canvas
  // always reports it, so treating "missing" as different would mark every new board unsaved.
  return `${elements.length}:${versionSum}:${last?.id ?? ""}:${scene.viewBackgroundColor ?? "#ffffff"}`;
}

export function formatWhiteboardDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
