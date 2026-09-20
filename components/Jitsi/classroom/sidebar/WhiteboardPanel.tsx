"use client";

import LiveWhiteboardViewer from "@/components/whiteboard/LiveWhiteboardViewer";
import WhiteboardEditor from "@/components/whiteboard/WhiteboardEditor";
import type { UserRole } from "../../types";

type WhiteboardPanelProps = {
  role: UserRole;
  sessionId: string;
  lectureId: string;
  /** False while another sidebar panel is showing (this panel stays mounted to keep the drawing). */
  active: boolean;
};

/**
 * Whiteboard tool of the classroom sidebar. The teacher draws and saves
 * (changes stream live to students); students see the teacher's board read-only.
 */
export default function WhiteboardPanel({ role, sessionId, lectureId, active }: WhiteboardPanelProps) {
  if (role === "teacher") {
    return (
      <WhiteboardEditor
        lectureId={lectureId}
        sessionId={sessionId}
        showSavedList
        active={active}
      />
    );
  }

  return <LiveWhiteboardViewer sessionId={sessionId} lectureId={lectureId} active={active} />;
}
