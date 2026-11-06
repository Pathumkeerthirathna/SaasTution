"use client";

// The Group Activities panel of the classroom sidebar: the teacher's Group
// Activities, or the student's Group Work. Shown only when the server has
// the breakout feature enabled (useGroupActivitiesAvailable).

import type { BreakoutController } from "../../../hooks/useBreakoutRooms";
import type { ClassroomStudent } from "../../../types";
import StudentGroupWorkPanel from "./StudentGroupWorkPanel";
import TeacherGroupActivitiesPanel from "./TeacherGroupActivitiesPanel";

export { useGroupActivitiesAvailable } from "./hooks";

export function groupActivitiesTitle(role: string): string {
  return role === "teacher" ? "Group Activities" : "Group Work";
}

export default function GroupActivitiesPanel({
  role,
  sessionId,
  breakout,
  studentLocations,
  students,
}: {
  role: string;
  sessionId: string;
  breakout?: BreakoutController;
  studentLocations?: ReadonlyMap<string, { participantId: string }>;
  students?: ClassroomStudent[];
}) {
  if (role === "teacher") {
    return <TeacherGroupActivitiesPanel sessionId={sessionId} breakout={breakout} studentLocations={studentLocations} students={students} />;
  }
  if (role === "student") return <StudentGroupWorkPanel sessionId={sessionId} />;
  return null;
}
