import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ StudentId: string }> }
) {
  try {
    const { StudentId } = await params;

    const student = await prisma.student.findUnique({
      where: {
        id: StudentId,
      }
      // ,
      // include: {
      //   guardians: true,
      //   classes: true,
      // },
    });

    console.log("Fetched student:", student);

    if (!student) {
      return NextResponse.json(
        {
          success: false,
          message: "Student not found",
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: student,
    });


  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,
        message: "Failed to load student",
      },
      { status: 500 }
    );
  }
}