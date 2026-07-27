import { NextRequest, NextResponse } from "next/server";
import { confirmStudent, declineStudent } from "../../../../../services/student-service";

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  console.log("🔥 Confirm route called");

  try {
    await declineStudent(params.id);

    return NextResponse.json({
      success: true,
      message: "Student confirmed successfully.",
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        message:
          error instanceof Error ? error.message : "Internal server error.",
      },
      { status: 400 }
    );
  }
}