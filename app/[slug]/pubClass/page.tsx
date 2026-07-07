

// export default function Page() {
//   return <ClassLandingPage />;
// }

import ClassLandingPage from "@/components/teacherProfile/classLanding/ClassLandingPage";

interface Props {
  params: {
    classId: string;
  };
}

export default function Page({ params }: Props) {
  return (
    <ClassLandingPage
      classId={params.classId}
    />
  );
}