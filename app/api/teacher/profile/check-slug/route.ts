import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireTeacherSession } from "@/lib/auth-session";

export async function GET(request: NextRequest) {
  try {
    
    const session = await requireTeacherSession();

    if (!session) {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    const slug =
      request.nextUrl.searchParams.get("slug")?.trim().toLowerCase();

    if (!slug) {
      return NextResponse.json(
        {
          available: false,
          message: "Slug is required.",
        },
        { status: 400 }
      );
    }

    const exists = await prisma.teacherProfile.findFirst({
      where: {
        slug,
        NOT: {
          teacherId: session.teacherId,
        },
      },
      select: {
        id: true,
      },
    });

    return NextResponse.json({
      available: !exists,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        available: false,
        message: "Something went wrong.",
      },
      { status: 500 }
    );
  }
}