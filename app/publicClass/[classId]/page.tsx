import ClassLandingPage from "@/components/teacherProfile/classLanding/ClassLandingPage";
import { getPublicClass, getPublicClassNotes } from "@/services/class-service";
import { getPublicClassSessionsWithUploads } from "@/services/recorded-lecture-public-service";
import { notFound } from "next/navigation";

interface Props {
  params: {
    classId: string;
  };
}

export default async function Page({ params }: Props) {
  const classInfo = await getPublicClass(params.classId);

  if (!classInfo) {
    notFound();
  }

  const [sessions, notes] = await Promise.all([
    getPublicClassSessionsWithUploads(params.classId),
    getPublicClassNotes(params.classId),
  ]);

  return (
    <ClassLandingPage classInfo={classInfo} sessions={sessions} notes={notes} />
  );
}
