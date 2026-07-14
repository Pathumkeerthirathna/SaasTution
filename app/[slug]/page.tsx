import { notFound } from "next/navigation";
import TeacherProfilePage from "@/components/teacherProfile/TeacherProfilePage";
import {  GetTeacherPublicProfileBySlug } from "@/services/teacher-profile-service";

interface Props {
  params: {
    slug: string;
  };
}

export default async function PublicTeacherPage({
  params,
}: Props) {


  const teacher = await GetTeacherPublicProfileBySlug(params.slug);

  console.log("teacher", teacher);


  if (!teacher) {
    notFound();
  }

  return (
    <TeacherProfilePage
      teacher={teacher}
      isPublic={true}
    />
  );
}