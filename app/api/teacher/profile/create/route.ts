import { NextRequest, NextResponse } from "next/server";
import { TeacherTitle } from "@prisma/client";

import { createTeacherProfile } from "@/services/teacher-profile-service";
import { requireTeacherSession } from "@/lib/auth-session";
import { TEACHER_TITLE_OPTIONS } from "@/lib/teacher-title";

export async function POST(request: NextRequest) {
  try {
    const session = await requireTeacherSession();

    const body = await request.json();

    const slug =
      typeof body?.slug === "string" ? body.slug : "";

    const displayName =
      typeof body?.displayName === "string" ? body.displayName : "";

    const title: TeacherTitle = TEACHER_TITLE_OPTIONS.includes(
      body?.title
    )
      ? body.title
      : "MR";

    const profile = await createTeacherProfile(
      session.teacherId,
      { title, displayName, slug }
    );

    return NextResponse.json(profile);
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to create profile.";

    return NextResponse.json(
      { message },
      { status: 400 }
    );
  }
}
