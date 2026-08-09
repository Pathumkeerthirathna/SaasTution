"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { JoinInfo, UserRole } from "../types";

export default function useJoinSession() {
  const searchParams = useSearchParams();

  const sessionId = searchParams.get("sessionId") ?? "";
  const studentId = searchParams.get("studentId") ?? "";
  const inviteToken = searchParams.get("invite") ?? "";

  const roleParam = searchParams.get("role");
  const role: UserRole =
    roleParam === "teacher" ? "teacher" : "student";

  const teacherName =
    searchParams.get("teacherName") ?? "Teacher";

  const [joinInfo, setJoinInfo] = useState<JoinInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canJoin = useMemo(() => {
    if (inviteToken.length > 0) return true;
    if (sessionId.length === 0) return false;
    if (role === "teacher") return true;
    return studentId.length > 0;
  }, [inviteToken, role, sessionId, studentId]);

  useEffect(() => {
    let cancelled = false;

    async function loadJoinInfo() {
      if (!canJoin) {
        setError(
          role === "teacher"
            ? "Missing session identifier."
            : "Missing session or student identifier."
        );
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        let response: Response;

        if (inviteToken) {
          const query = new URLSearchParams();
          query.set("invite", inviteToken);

          response = await fetch(
            `/api/sessions/join-info?${query.toString()}`
          );
        } else {
          const query = new URLSearchParams();

          query.set("role", role);

          if (studentId) {
            query.set("studentId", studentId);
          }

          response = await fetch(
            `/api/sessions/${sessionId}/join-info?${query.toString()}`
          );
        }

        const payload = await response.json();

        console.log(payload);

        if (!response.ok || !payload.success || !payload.data) {
          throw new Error(
            payload.error?.message ??
              "Unable to load classroom information."
          );
        }

        if (!cancelled) {
          setJoinInfo(payload.data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Unable to load classroom."
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadJoinInfo();

    return () => {
      cancelled = true;
    };
  }, [canJoin, inviteToken, role, sessionId, studentId]);

  return {
    joinInfo,
    loading,
    error,
    role,
    teacherName,
    sessionId,
    studentId,
    inviteToken,
  };
}