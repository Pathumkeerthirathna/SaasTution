import ExcelJS from "exceljs";

import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { listAllStudentsByTeacher, listStudentsByTeacher } from "@/services/student-service";

export async function GET(request: Request) {
  try {
    const session = await requireTeacherSession();

    const { searchParams } = new URL(request.url);

    const name =
      searchParams.get("name")?.trim() ?? "";

    const gradeId =
      Number(searchParams.get("grade") ?? 0);

    const sortBy =
      searchParams.get("sortBy") ??
      "registrationNumber";

    const sortOrder =
      searchParams.get("sortOrder") ??
      "asc";

    const { students } =
      await listAllStudentsByTeacher({
        teacherId: session.teacherId,
        name,
        gradeId: gradeId || undefined,
        sortBy,
        sortOrder,
      });

    const workbook =
      new ExcelJS.Workbook();

    const worksheet =
      workbook.addWorksheet("Students");

    worksheet.columns = [
      {
        header: "Registration Number",
        key: "registrationNumber",
        width: 25,
      },
      {
        header: "Student Name",
        key: "name",
        width: 30,
      },
      {
        header: "Grade",
        key: "grade",
        width: 20,
      },
      {
        header: "Contact 01",
        key: "contact01",
        width: 20,
      },
      {
        header: "Contact 02",
        key: "contact02",
        width: 20,
      },
      {
        header: "Email",
        key: "email",
        width: 30,
      },
    ];

    students.forEach((student) => {
      worksheet.addRow({
        registrationNumber:
          student.registrationNumber,
        name: student.name,
        grade:
          student.grade?.GradeDesc ?? "",
        contact01:
          student.contact01 ?? "",
        contact02:
          student.contact02 ?? "",
        email:
          student.email ?? "",
      });
    });

    const buffer =
      await workbook.xlsx.writeBuffer();

    return new Response(buffer, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",

        "Content-Disposition":
          'attachment; filename="Students.xlsx"',
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}