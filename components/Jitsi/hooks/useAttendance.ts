"use client";

import { useCallback, useRef } from "react";
import type { JoinInfo, UserRole } from "../types";
import { createAttendanceVisit } from "../attendance-visit";

/**
 * Student attendance: one Attendance row per actual visit. useJitsi calls
 * `markJoined` on every Jitsi "conference joined" and `markLeft` on a
 * confirmed leave (or page teardown); attendance-visit.ts turns that into
 * exactly one join request per visit and one leave request for that visit.
 */
export default function useAttendance(
  joinInfo: JoinInfo,
  role: UserRole
) {
  // The latest values for the requests (the visit tracker lives across renders).
  const joinInfoRef = useRef(joinInfo);
  joinInfoRef.current = joinInfo;
  const roleRef = useRef(role);
  roleRef.current = role;

  const visitRef = useRef<ReturnType<typeof createAttendanceVisit> | null>(null);
  // The session the current visit was recorded in. A leave goes there even if
  // the page has moved on to another session by the time it is sent (the
  // meeting is torn down after the new join info has arrived).
  const visitSessionIdRef = useRef<string | null>(null);

  if (!visitRef.current) {
    visitRef.current = createAttendanceVisit({
      join: async () => {
        const info = joinInfoRef.current;

        visitSessionIdRef.current = info.session.id;

        try {
          const response = await fetch("/api/attendance", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              sessionId: info.session.id,
              classId: info.class.id,
              // Validated, but the server records the logged-in student.
              studentId: info.student?.id,
            }),
          });

          if (!response.ok) {
            const error = await response.text();
            console.error("Failed to mark attendance:", error);
            return null;
          }

          const payload = (await response.json()) as {
            data?: { attendance?: { id?: string } };
          };

          return payload.data?.attendance?.id ?? null;
        } catch (error) {
          console.error("Error marking attendance:", error);
          return null;
        }
      },

      leave: async (attendanceId) => {
        const info = joinInfoRef.current;
        const sessionId = visitSessionIdRef.current ?? info.session.id;

        visitSessionIdRef.current = null;

        try {
          const response = await fetch(
            `/api/sessions/${sessionId}/leave`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              // Lets the request outlive a page refresh / tab close where the
              // browser supports it. Not guaranteed: if it is lost, the next
              // join (or the session end) closes the visit on the server.
              // Same-origin, so the login cookie is sent as usual.
              keepalive: true,
              body: JSON.stringify({
                studentId: info.student?.id,
                ...(attendanceId ? { attendanceId } : {}),
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
      },
    });
  }

  // Students only (teachers have no attendance).
  const markJoined = useCallback(async () => {
    if (roleRef.current !== "student" || !joinInfoRef.current.student?.id) {
      return;
    }

    await visitRef.current?.joined();
  }, []);

  const markLeft = useCallback(async () => {
    if (roleRef.current !== "student" || !joinInfoRef.current.student?.id) {
      return;
    }

    await visitRef.current?.left();
  }, []);

  return {
    markJoined,
    markLeft,
  };
}
