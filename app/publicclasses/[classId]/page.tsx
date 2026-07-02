import ClassLandingPage from "@/components/teacherProfile/classLanding/ClassLandingPage";

interface Props {
  params: Promise<{
    classId: string;
  }>;
}

export default async function Page({ params }: Props) {
  const { classId } = await params;

  return (
    <ClassLandingPage classId={classId} />
  );
}