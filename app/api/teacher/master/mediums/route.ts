import { NextResponse } from "next/server";

import {
  getMediums,
} from "@/services/teacher-profile-service";

export async function GET() {
  try {
    const mediums =
      await getMediums();

    return NextResponse.json(
      mediums
    );
  } catch (error: unknown) {
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