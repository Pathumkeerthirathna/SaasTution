import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { StudentQrPanel } from "@/components/student-portal/student-qr-panel";
import { Panel } from "@/components/student-portal/student-ui";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function StudentSettingsPage() {
  // Same session handling as app/student/layout.tsx.
  const token = cookies().get(AUTH_COOKIE_NAME)?.value;
  const session = token ? await verifyAuthToken(token) : null;
  if (!session || session.role !== "STUDENT") redirect("/login");

  const student = await prisma.student.findUnique({
    where: { id: session.sub },
    select: { name: true, registrationNumber: true },
  });
  if (!student) redirect("/login");

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

      <StudentQrPanel studentName={student.name} registrationNumber={student.registrationNumber} />
    </div>
  );
}
