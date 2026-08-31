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
      id: string;
    };
  }
) {
  try {
    const session =
      await requireTeacherSession();

    const { password } =
      await request.json();

    if (typeof password !== "string" || !password.trim()) {
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

    if (
      password.length < 8 ||
      !/[a-z]/.test(password) ||
      !/[A-Z]/.test(password) ||
      !/[0-9]/.test(password)
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Password must be at least 8 characters and include an uppercase letter, a lowercase letter and a number.",
        },
        {
          status: 400,
        }
      );
    }

    const student =
      await prisma.student.findFirst({
        where: {
          id: params.id,
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