import { NextResponse } from "next/server";

import {
    getDistricts
} from "@/services/teacher-profile-service";

export async function GET() {
  try {
    const mediums =
      await getDistricts();

    return NextResponse.json(
      mediums
    );
  }catch {
  return NextResponse.json(
    { message: "Failed to load districts" },
    { status: 400 }
  );
}
}