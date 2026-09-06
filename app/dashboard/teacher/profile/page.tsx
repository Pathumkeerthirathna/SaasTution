import { notFound } from "next/navigation";
import TeacherProfilePage from "../../../../components/teacherProfile/TeacherProfilePage";
import TeacherProfileSetupForm from "../../../../components/teacherProfile/TeacherProfileSetupForm";
import { requireTeacherSession } from "@/lib/auth-session";
import {
  getTeacherProfile,
  TeacherProfileSetupRequiredError,
} from "@/services/teacher-profile-service";
import { getTeacherProfileSections } from "@/services/teacher-profile-section-service";

export default async function Page() {
  const teacherSes = await requireTeacherSession();

  let teacher;

  try {
    teacher = await getTeacherProfile(teacherSes.teacherId);
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
