

// export default function Page() {
//   return <ClassLandingPage />;
// }

import ClassLandingPage from "@/components/teacherProfile/classLanding/ClassLandingPage";
import { getPublicClass } from "@/services/class-service";
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

  return <ClassLandingPage classInfo={classInfo} />;
}