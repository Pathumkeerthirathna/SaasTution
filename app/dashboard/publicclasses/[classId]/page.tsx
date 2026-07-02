import ClassLandingPage from "../../../../components/teacherProfile/classLanding/ClassLandingPage";


// export default function Page() {
//   return <ClassLandingPage />;
// }

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