import { StudentProfilePanel } from "@/components/student-portal/student-profile";

export const dynamic = "force-dynamic";

/**
 * The signed-in student's own profile (phone editable, SP-3) and attendance QR (display-only, SP-4). The student layout
 * (app/student/layout.tsx) and middleware require a student session; the
 * data comes from GET /api/students/me/profile, which takes the student from
 * that session only.
 */
export default function StudentProfilePage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">My Profile</h1>
        <p className="mt-1 text-sm text-muted">Your student account details and attendance QR code.</p>
      </div>
      <StudentProfilePanel />
    </div>
  );
}
