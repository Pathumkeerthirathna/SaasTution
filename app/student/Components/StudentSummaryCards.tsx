import { SummaryCard } from "@/components/student-portal/student-ui";
import { StudentProfile } from "./student-profile-page";

interface Props {
  student: StudentProfile;
}

export function StudentSummaryCards({
  student,
}: Props) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <SummaryCard
              title="Classes"
              value={student.classes.length.toString()} helper={""}      />

      <SummaryCard
        title="Guardians"
        value={student.guardians.length.toString()} helper={""}
      />

      {/* <SummaryCard
        title="Payments"
        value={student.payments.length.toString()}
      /> */}
    </div>
  );
}