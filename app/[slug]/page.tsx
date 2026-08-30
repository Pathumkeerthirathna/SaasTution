import { notFound } from "next/navigation";
import TeacherProfilePage from "@/components/teacherProfile/TeacherProfilePage";
import {  GetTeacherPublicProfileBySlug } from "@/services/teacher-profile-service";
import { getTeacherProfileSections } from "@/services/teacher-profile-section-service";

interface Props {
  params: {
    slug: string;
  };
}

export default async function PublicTeacherPage({
  params,
}: Props) {


  const teacher = await GetTeacherPublicProfileBySlug(params.slug);

  if (!teacher) {
    notFound();
  }

  const sections = await getTeacherProfileSections(teacher.teacherId);

  return (
    <TeacherProfilePage
      teacher={teacher}
      isPublic={true}
      sectionOrder={sections.map((section) => section.sectionType)}
    />
  );
}
