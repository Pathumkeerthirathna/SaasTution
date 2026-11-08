"use client";

import { QrIdentityCard } from "@/components/qr/qr-identity-card";

/*
 * "QR Identity" tab of the teacher's student profile (/dashboard/students/[id]).
 * Rendered only when the tab is opened; a QR is issued (explicit POST) only
 * when this tab finds none, and image GETs never create one. The
 * /api/students/[id]/qr/* routes check that the signed-in teacher owns the
 * student (404 otherwise).
 */

type StudentQrIdentityProps = {
  studentId: string;
  studentName: string;
  registrationNumber: string | null;
};

export function StudentQrIdentity({ studentId, studentName, registrationNumber }: StudentQrIdentityProps) {
  const base = `/api/students/${encodeURIComponent(studentId)}/qr`;

  return (
    <div className="rounded-lg border border-slate-200 bg-white" data-testid="teacher-student-qr">
      <div className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-[13px] font-semibold text-slate-900">QR Identity</h3>
        <p className="text-[12px] text-slate-500">
          The student&apos;s personal QR code. Share it only with the student — anyone holding it can identify as them.
        </p>
      </div>
      <div className="p-4">
        <QrIdentityCard
          variant="teacher"
          endpoints={{ status: `${base}/status`, issue: `${base}/issue`, image: base, regenerate: `${base}/regenerate` }}
          studentName={studentName}
          registrationNumber={registrationNumber}
        />
      </div>
    </div>
  );
}
