import ClassLandingPage from "@/components/teacherProfile/classLanding/ClassLandingPage";
import { getPublicClass } from "@/services/class-service";
import { notFound } from "next/navigation";

interface Props {
  params: Promise<{
    classId: string;
  }>;
}

export default async function Page({ params }: Props) {
  const classInfo = await getPublicClass((await params).classId);

  if (!classInfo) {
    notFound();
  }

  return <ClassLandingPage classInfo={classInfo} />;
}