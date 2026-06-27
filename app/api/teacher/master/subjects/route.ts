import { NextResponse } from "next/server";

import {
  getSubjects,
} from "@/services/teacher-profile-service";

export async function GET() {
  try {
    const subjects =
      await getSubjects();

    return NextResponse.json(subjects);
  } catch (error: any) {
    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to load subjects",
      },
      { status: 400 }
    );
  }
}