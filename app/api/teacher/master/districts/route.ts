import { reportRouteError } from "@/lib/error-handler";
import { NextResponse } from "next/server";

import {
    getDistricts
} from "@/services/teacher-profile-service";

export async function GET(request: Request) {
  try {
    const mediums =
      await getDistricts();

    return NextResponse.json(
      mediums
    );
  }catch (error) {
  reportRouteError(error, { request, statusCode: 400 });

  return NextResponse.json(
    { message: "Failed to load districts" },
    { status: 400 }
  );
}
}