import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";

import { prisma } from "@/lib/prisma";
import { requireTeacherSession } from "@/lib/auth-session";

export async function POST(
  request: Request,
  {
    params,
  }: {
    params: {
      studentId: string;
    };
  }
) {
  try {
    const session =
      await requireTeacherSession();

    const { password } =
      await request.json();

    if (!password?.trim()) {
      return NextResponse.json(
        {
          success: false,
          message: "Password is required.",
        },
        {
          status: 400,
        }
      );
    }

    const student =
      await prisma.student.findFirst({
        where: {
          id: params.studentId,
          teacherId: session.teacherId,
          status: {
            not: 2,
          },
        },
        select: {
          id: true,
        },
      });

    if (!student) {
      return NextResponse.json(
        {
          success: false,
          message: "Student not found.",
        },
        {
          status: 404,
        }
      );
    }

    const hashedPassword =
      await bcrypt.hash(password, 10);

    await prisma.student.update({
      where: {
        id: student.id,
      },
      data: {
        password: hashedPassword,
      },
    });

    return NextResponse.json({
      success: true,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,
        message:
          "Failed to reset password.",
      },
      {
        status: 500,
      }
    );
  }
}