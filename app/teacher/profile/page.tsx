import TeacherProfilePage from "@/components/teacherProfile/TeacherProfilePage";
import { requireTeacherSession } from "@/lib/auth-session";
import { getTeacherProfile } from "@/services/teacher-profile-service";

export default async function Page() {
  const teacher = await requireTeacherSession();

  const teacherProfile = await getTeacherProfile(
    teacher.teacherId
  );

  console.log("teacherProfile", teacherProfile);

  return (
    <TeacherProfilePage
      teacher={teacherProfile}
      isPublic={false}
    />
  );
}