"use client";

import "@excalidraw/excalidraw/index.css";

import { useCallback, useRef } from "react";
import { Excalidraw, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import type { WhiteboardElement, WhiteboardScene } from "@/types/whiteboard";
import { sceneSignature } from "./scene-utils";

export type { ExcalidrawImperativeAPI };

type Props = {
  /** Scene loaded when the canvas mounts. Remount (change `key`) to load another one. */
  initialScene?: WhiteboardScene | null;
  /** View-only: no drawing tools, used for students. */
  readOnly?: boolean;
  onReady?: (api: ExcalidrawImperativeAPI) => void;
  /** Called only when the drawing itself changed (not when the viewport moves). */
  onSceneChange?: (scene: WhiteboardScene) => void;
};

/** Converts stored elements back into Excalidraw elements. */
export function toExcalidrawElements(scene: WhiteboardScene): ExcalidrawElement[] {
  return restoreElements(scene.elements as unknown as ExcalidrawElement[], null) as ExcalidrawElement[];
}

export default function WhiteboardCanvas({ initialScene, readOnly = false, onReady, onSceneChange }: Props) {
  const lastSignatureRef = useRef<string | null>(null);

  const handleChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: { viewBackgroundColor?: string }) => {
      if (!onSceneChange) {
        return;
      }

      // Deleted elements and images are never part of a stored/broadcast scene.
      const scene: WhiteboardScene = {
        elements: elements.filter(
          (element) => !element.isDeleted && element.type !== "image"
        ) as unknown as WhiteboardElement[],
        viewBackgroundColor: appState.viewBackgroundColor,
      };

      const signature = sceneSignature(scene);

      if (signature === lastSignatureRef.current) {
        return;
      }

      lastSignatureRef.current = signature;
      onSceneChange(scene);
    },
    [onSceneChange]
  );

  return (
    <div className="h-full w-full">
      <Excalidraw
        excalidrawAPI={(api) => onReady?.(api)}
        initialData={{
          elements: initialScene ? toExcalidrawElements(initialScene) : [],
          appState: {
            viewBackgroundColor: initialScene?.viewBackgroundColor ?? "#ffffff",
          },
          scrollToContent: true,
        }}
        viewModeEnabled={readOnly}
        onChange={handleChange}
        theme="light"
        // Image insertion is disabled: images would need embedded base64 files,
        // which are deliberately never stored in a whiteboard.
        UIOptions={{
          tools: { image: false },
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            saveAsImage: false,
            export: false,
            toggleTheme: false,
          },
        }}
      />
    </div>
  );
}
