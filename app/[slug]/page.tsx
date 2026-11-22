import type { Metadata } from "next";
import { notFound } from "next/navigation";

import TeacherProfilePage from "@/components/teacherProfile/TeacherProfilePage";
import { siteOrigin } from "@/lib/site-url";
import { buildTeacherProfileMetadata, buildUnavailableProfileMetadata } from "@/lib/teacher-profile/share-metadata";
import { getPublishedPaymentAccounts } from "@/services/teacher-payment-account-service";
import { getTeacherProfileSections } from "@/services/teacher-profile-section-service";
import { findPublicTeacherProfileBySlug, getPublicTeacherShareData } from "@/services/teacher-profile-service";
import { resolveTeacherProfileViewer, splitClassesForStudent } from "@/services/teacher-profile-viewer-service";

interface Props {
  params: {
    slug: string;
  };
}

// Always rendered per request: profile edits (name, photo, visibility) show up at once,
// and a profile made private stops being served immediately.
export const dynamic = "force-dynamic";

/**
 * Link-preview metadata, server-rendered into the first HTML response (what
 * WhatsApp, Facebook, Telegram and X read). Same visibility rule as the page:
 * unknown or private profiles get generic, noindex metadata.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await getPublicTeacherShareData(params.slug);
  if (!data) return buildUnavailableProfileMetadata();
  return buildTeacherProfileMetadata(data, siteOrigin());
}

export default async function PublicTeacherPage({
  params,
}: Props) {
  // null for an unknown or private profile: HTTP 404 (database errors are not caught).
  const teacher = await findPublicTeacherProfileBySlug(params.slug);

  if (!teacher) {
    notFound();
  }

  // Role from the server-side session only (never from the URL or the client): the owner gets the
  // Payment Details management card, a related student gets their enrolled / available classes;
  // everyone else gets the public profile. The rest of the page is the public profile for all.
  const [sections, viewer, paymentAccounts] = await Promise.all([
    getTeacherProfileSections(teacher.teacherId),
    resolveTeacherProfileViewer(teacher.teacherId),
    getPublishedPaymentAccounts(teacher.teacherId),
  ]);
  const studentClasses =
    viewer.role === "STUDENT" ? await splitClassesForStudent(viewer.studentId, teacher.teacherId, teacher.classes) : undefined;

  return (
    <TeacherProfilePage
      teacher={teacher}
      isPublic={true}
      sectionOrder={sections.map((section) => section.sectionType)}
      viewerRole={viewer.role}
      paymentAccounts={paymentAccounts}
      studentClasses={studentClasses}
    />
  );
}
