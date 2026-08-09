"use client";

import { useCallback } from "react";
import type { JoinInfo, UserRole } from "../types";

export default function useAttendance(
  joinInfo: JoinInfo,
  role: UserRole
) {
  const markJoined = useCallback(async () => {
    if (role !== "student" || !joinInfo.student?.id) {
      return;
    }

    try {
      const response = await fetch("/api/attendance", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: joinInfo.session.id,
          classId: joinInfo.class.id,
          studentId: joinInfo.student.id,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("Failed to mark attendance:", error);
      }
    } catch (error) {
      console.error("Error marking attendance:", error);
    }
  }, [joinInfo, role]);

  const markLeft = useCallback(async () => {
    if (role !== "student" || !joinInfo.student?.id) {
      return;
    }

    try {
      const response = await fetch(
        `/api/sessions/${joinInfo.session.id}/leave`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            studentId: joinInfo.student.id,
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        console.error("Failed to mark student as left:", error);
      }
    } catch (error) {
      console.error("Error marking student as left:", error);
    }
  }, [joinInfo, role]);

  return {
    markJoined,
    markLeft,
  };
}