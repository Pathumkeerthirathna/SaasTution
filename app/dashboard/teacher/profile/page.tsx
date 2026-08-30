import { notFound } from "next/navigation";
import TeacherProfilePage from "../../../../components/teacherProfile/TeacherProfilePage";
import { requireTeacherSession } from "@/lib/auth-session";
import { getTeacherProfile } from "@/services/teacher-profile-service";
import { getTeacherProfileSections } from "@/services/teacher-profile-section-service";

export default async function Page() {
  const teacherSes = await requireTeacherSession();

  const teacher = await getTeacherProfile(teacherSes.teacherId);

  if (!teacher) {
    notFound();
  }

  const sections = await getTeacherProfileSections(teacherSes.teacherId);

  return (
    <TeacherProfilePage
      teacher={teacher}
      isPublic={false}
      sectionOrder={sections.map((section) => section.sectionType)}
    />
  );
}
