import { NextResponse } from "next/server";

import {
  getSubjects,
} from "@/services/teacher-profile-service";

export async function GET() {
  try {
    const subjects =
      await getSubjects();

    return NextResponse.json(subjects);
  }catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load mediums";

    return NextResponse.json(
      { message },
      { status: 400 }
    );
  }
}