import { notFound } from "next/navigation";
import TeacherProfilePage from "../../../../components/teacherProfile/TeacherProfilePage";
import { TeacherProfile } from "@/types/teacherProfileTypes/ClassTeacher";
import { requireTeacherSession } from "@/lib/auth-session";
import { getTeacherProfile } from "@/services/teacher-profile-service";


export default async function Page() {


  const teacherSes = await requireTeacherSession();

  const response =  await getTeacherProfile(teacherSes.teacherId);

    if (!response) {
      notFound();
    }

  const teacher: TeacherProfile = await response;

  if (!teacher) {
    notFound();
  }

  console.log("teacher profile page", teacher);

  return (
    <TeacherProfilePage
      teacher={teacher}
      isPublic={false}
    />
  );
}