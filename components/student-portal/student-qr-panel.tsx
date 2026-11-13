"use client";

import { QrIdentityCard } from "@/components/qr/qr-identity-card";
import { STUDENT_QR_PANEL_ID } from "@/components/student-portal/student-data";
import { Panel } from "@/components/student-portal/student-ui";

/*
 * "My Attendance QR" (My Profile, Student Profile SP-4): the signed-in
 * student's own QR, display-only: view and download. No regenerate endpoint
 * is passed, so the shared card offers no regeneration (button, confirmation
 * or counts). The /api/students/me/qr/* routes take the student from the
 * session; the PNG is shown through an in-memory blob URL (no token in JSON
 * or URLs) and every response is no-store.
 */

export const STUDENT_QR_ENDPOINTS = {
  status: "/api/students/me/qr/status",
  issue: "/api/students/me/qr/issue",
  image: "/api/students/me/qr",
} as const;

type StudentQrPanelProps = {
  studentName: string;
  registrationNumber: string | null;
};

export function StudentQrPanel({ studentName, registrationNumber }: StudentQrPanelProps) {
  return (
    <Panel
      id={STUDENT_QR_PANEL_ID}
      title="My Attendance QR"
      subtitle="Show this QR code to your teacher to mark your attendance. Keep it private — anyone with it can identify as you."
    >
      <QrIdentityCard
        variant="student"
        endpoints={STUDENT_QR_ENDPOINTS}
        studentName={studentName}
        registrationNumber={registrationNumber}
        enlargeable
      />
    </Panel>
  );
}
