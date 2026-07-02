import { NextResponse } from "next/server";

import {
    getDistricts,
  getMediums,
} from "@/services/teacher-profile-service";

export async function GET() {
  try {
    const mediums =
      await getDistricts();

    return NextResponse.json(
      mediums
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to load mediums",
      },
      { status: 400 }
    );
  }
}