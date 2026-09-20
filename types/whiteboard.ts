/**
 * A whiteboard drawing. Elements are Excalidraw scene elements, kept loosely
 * typed here so server code never has to import the Excalidraw package.
 * Embedded images (and the `files` map that carries their base64 data) are
 * never part of a scene.
 */
export type WhiteboardElement = Record<string, unknown> & { id: string; type: string };

export interface WhiteboardScene {
  elements: WhiteboardElement[];
  viewBackgroundColor?: string;
}

export interface WhiteboardListItem {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface WhiteboardDetail extends WhiteboardListItem {
  lectureId: string;
  data: WhiteboardScene;
}

/** Payload pushed to students while the teacher draws. */
export interface WhiteboardLiveUpdate {
  sessionId: string;
  seq: number;
  scene: WhiteboardScene;
  occurredAt: string;
}
