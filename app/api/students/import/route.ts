import { reportRouteError } from "@/lib/error-handler";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireTeacherSession } from "@/lib/auth-session";
import { StudentConfirmationStatus, StudentRegistrationSource } from "@prisma/client";
import {
    generateAvailableRegistrationNumbers,
    isRegistrationNumberConflict,
    normalizeRegistrationNumber,
} from "@/services/student-service";

type ImportStudentRow = {
    registrationNumber?: string;
    studentName: string;
    gradeId: number | null;
    primaryContact?: string;
    secondaryContact?: string;
    email?: string;
};

type ImportStudentRequest = {
  registrationSource: StudentRegistrationSource;
  students: ImportStudentRow[];
};

export async function POST(request: Request) {
    
    try {
    
    const session = await requireTeacherSession();
    
    const body = (await request.json()) as ImportStudentRequest;

    const { registrationSource, students } = body;


    if (!Array.isArray(students)) {
        return NextResponse.json(
            {
            success: false,
            message: "Invalid payload.",
            },
            {
            status: 400,
            }
        );
    }

    const errors: {
        row: number;
        field: string;
        message: string;
    }[] = [];

    // ----------------------------------
    // Validate Uploaded File Duplicates
    // ----------------------------------

    const registrationMap = new Map<string,number>();

    students.forEach((student, index) => {
    
        const rowNumber = index + 2;

        if (
            student.registrationNumber &&
            student.registrationNumber.trim()
        ) {
            const reg =
            normalizeRegistrationNumber(student.registrationNumber);

            if (registrationMap.has(reg)) {
            errors.push({
                row: rowNumber,
                field: "registrationNumber",
                message:
                "Duplicate registration number in uploaded file.",
            });
            }

            registrationMap.set(reg, rowNumber);
        }
    });

    // const uploadedStudentMap = new Map<string,number>();

    const uploadedStudentMap = new Map<
    string,
    {
        row: number;
        registrationNumber?: string;
        studentName: string;
    }
    >();

    students.forEach((student, index) => {
        const rowNumber = index + 2;

        if (!student.studentName?.trim()) {
        return;
        }

        const key = `${student.gradeId}|${student.studentName
                    .trim()
                    .replace(/\s+/g, " ")
                    .toLowerCase()}`;

        // if (uploadedStudentMap.has(key)) {
        //     errors.push({
        //     row: rowNumber,
        //     field: "studentName",
        //     message:
        //     "Duplicate student name found in uploaded file for the same grade.",
        //     });
        // }

        // uploadedStudentMap.set(key, rowNumber);

        const existingDuplicate =
            uploadedStudentMap.get(key);

            if (existingDuplicate) {
            errors.push({
                row: rowNumber,
                field: "studentName",
                message:
                `Duplicate student detected.
                Current Row: ${rowNumber}
                First Row: ${existingDuplicate.row}
                Name: ${student.studentName}
                Grade: ${student.gradeId}`,
            });
            } else {
            uploadedStudentMap.set(key, {
                row: rowNumber,
                registrationNumber:
                student.registrationNumber?.trim(),
                studentName:
                student.studentName.trim(),
            });
            }

    });


    // ----------------------------------
    // Row Validations
    // ----------------------------------

    students.forEach((student, index) => {
        const rowNumber = index + 2;

        if (!student.studentName?.trim()) {
            errors.push({
            row: rowNumber,
            field: "studentName",
            message:
                "Student name is required.",
            });
        }

        if (!student.gradeId) {
            errors.push({
            row: rowNumber,
            field: "gradeId",
            message: "Grade is required.",
            });
        }

        // Every student needs an email to log in and reset their password.
        if (!student.email?.trim()) {
            errors.push({
            row: rowNumber,
            field: "email",
            message:
                "Email is required.",
            });
        } else if (
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
            student.email.trim()
            )
        ) {
            errors.push({
            row: rowNumber,
            field: "email",
            message:
                "Invalid email address.",
            });
        }
    });

    // ----------------------------------
    // Grade Validation
    // ----------------------------------

    const gradeIds = [
        ...new Set(
            students
            .map((s) => s.gradeId)
            .filter(Boolean)
        ),
    ] as number[];

    const grades = await prisma.grade.findMany({
        where: {
        id: {
            in: gradeIds,
        },
        },
        select: {
        id: true,
        },
});

    const validGradeIds = new Set(
    grades.map((g) => g.id)
    );

    students.forEach((student, index) => {
        const rowNumber = index + 2;

        if (
            student.gradeId &&
            !validGradeIds.has(student.gradeId)
        ) {
            errors.push({
            row: rowNumber,
            field: "gradeId",
            message: "Invalid grade.",
            });
        }
    });

    // ----------------------------------
    // DB Duplicate Validation
    // ----------------------------------

    // Registration numbers are unique across every teacher's non-deleted
    // students; a deleted student's number may be reused.
    const registrationNumbers = students
    .map((s) =>
        s.registrationNumber?.trim() ? normalizeRegistrationNumber(s.registrationNumber) : ""
    )
    .filter(Boolean) as string[];

    if (registrationNumbers.length > 0) {
    const existingStudents =
        await prisma.student.findMany({
        where: {
            registrationNumber: {
            in: registrationNumbers,
            mode: "insensitive",
            },
            status: {
            not: 2,
            },
        },
        select: {
            registrationNumber: true,
        },
        });

    const existingSet = new Set(existingStudents.map((s) => normalizeRegistrationNumber(s.registrationNumber ?? ""))
);

    students.forEach((student, index) => {
        const rowNumber = index + 2;

            if (
                student.registrationNumber?.trim() &&
                existingSet.has(
                    normalizeRegistrationNumber(student.registrationNumber)
                )
            ) {
            errors.push({
                row: rowNumber,
                field: "registrationNumber",
                message:
                "Registration number already exists.",
            });
            }
        });
    }

    // ----------------------------------
    // Stop If Validation Failed
    // ----------------------------------

    const existingStudentsByTeacher =
        await prisma.student.findMany({
            where: {
            teacherId: session.teacherId,
            status: {
            not: 2,
            },
            },
            select: {
            registrationNumber: true,
            name: true,
            gradeId: true,
        },
    });

    const existingStudentMap = new Map(
        existingStudentsByTeacher.map(
            (student) => [
            `${student.gradeId}|${student.name
                .trim()
                .replace(/\s+/g, " ")
                .toLowerCase()}`,
            student,
            ]
        )
    );

    students.forEach((student, index) => {
        const rowNumber = index + 2;

        if (!student.studentName?.trim()) {
        return;
        }

        const key =
            `${student.gradeId}|${student.studentName
            .trim()
            .replace(/\s+/g, " ")
            .toLowerCase()}`;

        const existingStudent =
        existingStudentMap.get(key);

        if (existingStudent) {
        errors.push({
            row: rowNumber,
            field: "studentName",
            message:
            `Student already exists in database. Row ${rowNumber} matches existing student (Reg No: ${
                existingStudent.registrationNumber || "N/A"
            }, Name: ${existingStudent.name}, Grade: ${
                existingStudent.gradeId
            })`,
        });
        }
    });

    // ----------------------------------
    // Email Uniqueness
    // ----------------------------------
    // Same rule as assertEmailAvailable (used by the add form and public
    // registration): an email can't be shared with another student of this
    // teacher, a teacher account, or a guardian account. Checked in bulk so
    // every clash is reported at once.

    const firstRowByEmail = new Map<string, number>();

    students.forEach((student, index) => {
        const rowNumber = index + 2;
        const email = student.email?.trim().toLowerCase();

        if (!email) {
            return;
        }

        const firstRow = firstRowByEmail.get(email);

        if (firstRow) {
            errors.push({
            row: rowNumber,
            field: "email",
            message:
                `Duplicate email in uploaded file (same as row ${firstRow}).`,
            });
        } else {
            firstRowByEmail.set(email, rowNumber);
        }
    });

    const uploadedEmails = [...firstRowByEmail.keys()];

    if (uploadedEmails.length > 0) {
        const [existingStudentEmails, teacherEmails, guardianEmails] =
            await Promise.all([
            prisma.student.findMany({
                where: {
                teacherId: session.teacherId,
                email: {
                    in: uploadedEmails,
                    mode: "insensitive",
                },
                // Deleted students (status 2) no longer hold their email.
                status: { not: 2 },
                },
                select: { email: true },
            }),
            prisma.teacher.findMany({
                where: { email: { in: uploadedEmails } },
                select: { email: true },
            }),
            prisma.guardian.findMany({
                where: { email: { in: uploadedEmails } },
                select: { email: true },
            }),
            ]);

        const clashMessages = new Map<string, string>();

        guardianEmails.forEach(({ email }) => {
            if (email) {
            clashMessages.set(email.toLowerCase(), "This email is already in use by another account.");
            }
        });

        existingStudentEmails.forEach(({ email }) => {
            if (email) {
            clashMessages.set(email.toLowerCase(), "Another student already uses this email.");
            }
        });

        teacherEmails.forEach(({ email }) => {
            clashMessages.set(email.toLowerCase(), "This email is already in use by a teacher account.");
        });

        students.forEach((student, index) => {
            const email = student.email?.trim().toLowerCase();
            const message = email ? clashMessages.get(email) : undefined;

            if (message) {
            errors.push({
                row: index + 2,
                field: "email",
                message,
            });
            }
        });
    }


    if (errors.length > 0) {
    return NextResponse.json(
        {
        success: false,
        errors,
        },
        {
        status: 400,
        }
    );
    }

    // ----------------------------------
    // Prepare Students
    // ----------------------------------

    // Rows without a number get the lowest free numbers for this teacher's
    // prefix (the same generator as the Add Student form), skipping numbers
    // typed in other rows of this file.
    const teacher = await prisma.teacher.findUnique({
        where: { id: session.teacherId },
        select: { name: true },
    });

    const generatedNumbers = await generateAvailableRegistrationNumbers(
        teacher?.name ?? session.name,
        students.filter((s) => !s.registrationNumber?.trim()).length,
        registrationNumbers
    );

    const studentsToCreate = [];

    for (const student of students) {
    const registrationNumber =
        student.registrationNumber?.trim()
        ? normalizeRegistrationNumber(student.registrationNumber)
        : generatedNumbers.shift()!;

    studentsToCreate.push({
        registrationNumber,

        name: student.studentName.trim(),

        teacherId: session.teacherId,

        contact:
        student.primaryContact?.trim() ||
        student.secondaryContact?.trim() ||
        "",

        gradeId: student.gradeId!,

        contact01:
        student.primaryContact?.trim() ||
        null,

        contact02:
        student.secondaryContact?.trim() ||
        null,

        email:
        student.email?.trim() ||
        null,
        registrationSource:registrationSource,
        confirmationStatus:StudentConfirmationStatus.APPROVED,

        status: 0,
        });

    }

    // ----------------------------------
    // Save All Or Nothing
    // ----------------------------------

    try {
        await prisma.student.createMany({
            data: studentsToCreate,
        });
    } catch (error) {
        // A number was taken by a concurrent registration after the checks
        // above (database unique index). Nothing was saved.
        if (isRegistrationNumberConflict(error)) {
            return NextResponse.json(
                {
                success: false,
                errors: [
                    {
                    row: 0,
                    field: "registrationNumber",
                    message:
                        "A registration number was taken by another registration while importing. Nothing was imported; please try again.",
                    },
                ],
                },
                {
                status: 409,
                }
            );
        }

        throw error;
    }

    return NextResponse.json({
    success: true,
    count: studentsToCreate.length,
    });

    } catch (error) {
    reportRouteError(error, { request });


    return NextResponse.json(
    {
        success: false,
        message:
        "Failed to import students.",
    },
    {
        status: 500,
    }
    );


    }
}
