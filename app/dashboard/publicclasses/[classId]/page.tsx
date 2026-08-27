import { getPublicClass, getPublicClassSessions } from "@/services/class-service";
import ClassLandingPage from "../../../../components/teacherProfile/classLanding/ClassLandingPage";
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

  const sessions = await getPublicClassSessions(params.classId);

  return <ClassLandingPage classInfo={classInfo} sessions={sessions} />;
}
