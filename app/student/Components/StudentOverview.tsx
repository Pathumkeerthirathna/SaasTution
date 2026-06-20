import {
  User,
  GraduationCap,
  Phone,
  Mail,
  Hash,
  Calendar,
} from "lucide-react";

interface Student {
  id: string;
  name: string;
  contact: string;
  email: string | null;
  contact01: string | null;
  contact02: string | null;
  registrationNumber: string | null;
  gradeId: number | null;
  status: number;
  teacherId: string;
  createdAt: string;
  actionTakenDate: string | null;
  grade?: { name: string } | null;
  classes?: Array<{ classId: string }>;
  guardians?: Array<{ id: string }>;
}

interface StudentDetailsProps {
  student: Student;
}

export function StudentOverview({
  student,
}: StudentDetailsProps) {
  const details = [
    {
      label: "Student Name",
      value: student.name,
      icon: User,
      color: "text-blue-600 bg-blue-50",
    },
    {
      label: "Registration Number",
      value: student.registrationNumber,
      icon: Hash,
      color: "text-violet-600 bg-violet-50",
    },
    {
      label: "Grade",
      value: student.grade?.name?.replace("_", " "),
      icon: GraduationCap,
      color: "text-emerald-600 bg-emerald-50",
    },
    {
      label: "Contact Number",
      value: student.contact,
      icon: Phone,
      color: "text-amber-600 bg-amber-50",
    },
    {
      label: "Email Address",
      value: student.email,
      icon: Mail,
      color: "text-rose-600 bg-rose-50",
    },
    {
      label: "Created Date",
      value: student.createdAt
        ? new Date(student.createdAt).toLocaleDateString()
        : "-",
      icon: Calendar,
      color: "text-cyan-600 bg-cyan-50",
    },
  ];

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="border-b border-slate-200 px-5 py-4">
        <h2 className="text-base font-semibold text-slate-900">
          Student Details
        </h2>

        <p className="mt-1 text-sm text-slate-500">
          General information about the student
        </p>
      </div>

      {/* Content */}
      <div className="grid gap-4 p-5 md:grid-cols-2">
        {details.map((item) => {
          const Icon = item.icon;

          return (
            <div
              key={item.label}
              className="rounded-lg border border-slate-100 bg-slate-50/50 p-4"
            >
              <div className="flex items-start gap-3">
                <div
                  className={`flex h-10 w-10 items-center justify-center rounded-lg ${item.color}`}
                >
                  <Icon className="h-5 w-5" />
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    {item.label}
                  </p>

                  <p className="mt-1 break-words text-sm font-medium text-slate-900">
                    {item.value || "-"}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}