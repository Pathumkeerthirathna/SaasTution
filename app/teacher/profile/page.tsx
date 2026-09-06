import TeacherProfilePage from "@/components/teacherProfile/TeacherProfilePage";
import TeacherProfileSetupForm from "@/components/teacherProfile/TeacherProfileSetupForm";
import { requireTeacherSession } from "@/lib/auth-session";
import {
  getTeacherProfile,
  TeacherProfileSetupRequiredError,
} from "@/services/teacher-profile-service";
import { getTeacherProfileSections } from "@/services/teacher-profile-section-service";

export default async function Page() {
  const teacher = await requireTeacherSession();

  let teacherProfile;

  try {
    teacherProfile = await getTeacherProfile(teacher.teacherId);
  } catch (error) {
    if (error instanceof TeacherProfileSetupRequiredError) {
      return (
        <TeacherProfileSetupForm
          teacherName={error.teacherName}
          suggestedSlug={error.suggestedSlug}
          slugAvailable={error.slugAvailable}
          alternatives={error.alternatives}
        />
      );
    }

    throw error;
  }

  const sections = await getTeacherProfileSections(teacher.teacherId);

  return (
    <TeacherProfilePage
      teacher={teacherProfile}
      isPublic={false}
      sectionOrder={sections.map((section) => section.sectionType)}
    />
  );
}
