import ClassLandingPage from "@/components/teacherProfile/classLanding/ClassLandingPage";
import { getPublicClass, getPublicClassNotes, getPublicClassSessions } from "@/services/class-service";
import { notFound } from "next/navigation";

interface Props {
  params: Promise<{
    classId: string;
  }>;
}

export default async function Page({ params }: Props) {
  const { classId } = await params;
  const classInfo = await getPublicClass(classId);

  if (!classInfo) {
    notFound();
  }

  const [sessions, notes] = await Promise.all([
    getPublicClassSessions(classId),
    getPublicClassNotes(classId),
  ]);

  return (
    <ClassLandingPage classInfo={classInfo} sessions={sessions} notes={notes} />
  );
}