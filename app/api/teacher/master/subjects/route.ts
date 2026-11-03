import { developmentOnly, reportRouteError } from "@/lib/error-handler";
import { NextResponse } from "next/server";

import {
  getSubjects,
} from "@/services/teacher-profile-service";

export async function GET(request: Request) {
  try {
    const subjects =
      await getSubjects();

    return NextResponse.json(subjects);
  }catch (error: unknown) {
    reportRouteError(error, { request, statusCode: 400 });

    // The raw message only in development: in production it can hold database details.
    const message =
      developmentOnly(error instanceof Error ? error.message : undefined) ??
      "Failed to load subjects";

    return NextResponse.json(
      { message },
      { status: 400 }
    );
  }
}