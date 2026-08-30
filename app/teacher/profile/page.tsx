import TeacherProfilePage from "@/components/teacherProfile/TeacherProfilePage";
import { requireTeacherSession } from "@/lib/auth-session";
import { getTeacherProfile } from "@/services/teacher-profile-service";
import { getTeacherProfileSections } from "@/services/teacher-profile-section-service";

export default async function Page() {
  const teacher = await requireTeacherSession();

  const [teacherProfile, sections] = await Promise.all([
    getTeacherProfile(teacher.teacherId),
    getTeacherProfileSections(teacher.teacherId),
  ]);

  return (
    <TeacherProfilePage
      teacher={teacherProfile}
      isPublic={false}
      sectionOrder={sections.map((section) => section.sectionType)}
    />
  );
}
