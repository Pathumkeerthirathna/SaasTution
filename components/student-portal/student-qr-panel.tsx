"use client";

import { QrIdentityCard } from "@/components/qr/qr-identity-card";
import { Panel } from "@/components/student-portal/student-ui";

/* "My QR Identity" (Student Settings): the signed-in student's own QR. */

const STUDENT_QR_ENDPOINTS = {
  status: "/api/students/me/qr/status",
  issue: "/api/students/me/qr/issue",
  image: "/api/students/me/qr",
  regenerate: "/api/students/me/qr/regenerate",
};

type StudentQrPanelProps = {
  studentName: string;
  registrationNumber: string | null;
};

export function StudentQrPanel({ studentName, registrationNumber }: StudentQrPanelProps) {
  return (
    <Panel
      id="my-qr-identity"
      title="My QR Identity"
      subtitle="Your personal QR code. Keep it private — anyone with it can identify as you."
    >
      <QrIdentityCard
        variant="student"
        endpoints={STUDENT_QR_ENDPOINTS}
        studentName={studentName}
        registrationNumber={registrationNumber}
      />
    </Panel>
  );
}
