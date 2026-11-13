import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { STUDENT_QR_PANEL_ID } from "@/components/student-portal/student-data";
import { Panel } from "@/components/student-portal/student-ui";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { checkStudentSessionAccess } from "@/lib/student-session";

export const dynamic = "force-dynamic";

export default async function StudentSettingsPage() {
  // Same session handling as app/student/layout.tsx.
  const token = cookies().get(AUTH_COOKIE_NAME)?.value;
  const session = token ? await verifyAuthToken(token) : null;
  if (!session || session.role !== "STUDENT") redirect("/login");

  // Central student check (exists, active, session version); replaces the plain existence check.
  if ((await checkStudentSessionAccess(session)) !== "ACTIVE") redirect("/login");

  return (
    <div className="flex flex-col gap-6">
      <Panel title="Settings" subtitle="Manage account and privacy settings.">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium text-slate-900">Password and account security</p>
            <p className="text-sm text-slate-600">Change your password and keep your account protected.</p>
          </div>
          <Link
            href="/account/security"
            className="inline-flex items-center justify-center rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white"
          >
            Open Security Settings
          </Link>
        </div>
      </Panel>

      {/* SP-4: the attendance QR lives on My Profile only (one QR card, no duplicate state). */}
      <Panel title="My Attendance QR" subtitle="View or download the QR code you show your teacher for attendance.">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-slate-600">Your attendance QR code is on your profile page.</p>
          <Link
            href={`/student/profile#${STUDENT_QR_PANEL_ID}`}
            className="inline-flex items-center justify-center rounded-xl border border-brand-200 bg-white px-4 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50"
          >
            Open My Attendance QR
          </Link>
        </div>
      </Panel>
    </div>
  );
}
