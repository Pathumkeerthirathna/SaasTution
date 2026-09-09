import { requireGuardianSession } from "@/lib/guardian-auth-session";
import { assertGuardianLinkedToStudent } from "@/services/guardian-portal-service";

/**
 * Shared entry check for every guardian-portal student route: require a
 * guardian session and confirm the guardian is linked to the requested
 * student. Returns the resolved ids for the handler.
 */
export async function requireGuardianStudentAccess(studentId: string) {
  const session = await requireGuardianSession();
  const link = await assertGuardianLinkedToStudent(session.guardianId, studentId);

  return { guardianId: session.guardianId, studentId, relation: link.relation };
}
