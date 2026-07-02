import { NextResponse } from "next/server";
import { requireAppSession } from "@/lib/auth-session";
import { getMediums } from "@/services/teacher-profile-service";

export async function GET() {
  try {
    const session = await requireAppSession();

    if (!session?.userId || session.role !== "TEACHER") {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    const mediums = await getMediums();

    return NextResponse.json(mediums);

  } catch (error: any) {

    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to load mediums.",
      },
      {
        status: 400,
      }
    );

  }
}