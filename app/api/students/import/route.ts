import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireTeacherSession } from "@/lib/auth-session";
import { generateStudentRegistrationNumber } from "@/services/student-service";

type ImportStudentRow = {
    registrationNumber?: string;
    studentName: string;
    gradeId: number | null;
    primaryContact?: string;
    secondaryContact?: string;
    email?: string;
};

export async function POST(request: Request) {
    
    try {
    
    const session = await requireTeacherSession();
    
    const students = (await request.json()) as ImportStudentRow[];


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
            student.registrationNumber.trim();

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

        if (
            student.email &&
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
            student.email
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

    const registrationNumbers = students
    .map((s) =>
        s.registrationNumber?.trim()
    )
    .filter(Boolean) as string[];

    if (registrationNumbers.length > 0) {
    const existingStudents =
        await prisma.student.findMany({
        where: {
            registrationNumber: {
            in: registrationNumbers,
            },
        },
        select: {
            registrationNumber: true,
        },
        });

    const existingSet = new Set(existingStudents.map((s) => s.registrationNumber)
);

    students.forEach((student, index) => {
        const rowNumber = index + 2;

            if (
                student.registrationNumber?.trim() &&
                existingSet.has(
                    student.registrationNumber.trim()
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

    const year = new Date().getFullYear();

    const teacherCode = session.name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 3);

    const prefix = `${teacherCode}-${year}`;

    const currentCount = await prisma.student.count({
    where: {
        registrationNumber: {
        startsWith: `${prefix}-`,
        },
    },
    });

    let nextSequence = currentCount + 1;

    const studentsToCreate = [];

    for (const student of students) {
    let registrationNumber =
        student.registrationNumber?.trim();

    if (!registrationNumber) {
    registrationNumber =
        `${prefix}-${String(
        nextSequence++
        ).padStart(3, "0")}`;
    }

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

        status: 0,
        });

    }

    // ----------------------------------
    // Save All Or Nothing
    // ----------------------------------

    await prisma.student.createMany({
        data: studentsToCreate,
    });

    return NextResponse.json({
    success: true,
    count: studentsToCreate.length,
    });

    } catch (error) {
    console.error(error);


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
