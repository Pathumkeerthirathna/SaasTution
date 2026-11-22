import { developmentOnly, reportRouteError } from "@/lib/error-handler";
import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function GET(request: Request) {
  try {
    // Every grade, Grade 0 (id 0, "no school grade") first. Teacher screens
    // list them all; the public registration form leaves Grade 0 out and
    // offers "No specific grade" instead (lib/grade.ts).
    const grades = await prisma.grade.findMany({
      orderBy: { id: "asc" },
    });

    return NextResponse.json(grades);
  } catch (error) {
    reportRouteError(error, { request, statusCode: 500 });

    return NextResponse.json(
      { message: "Failed to retrieve grades", error: developmentOnly(error) },
      { status: 500 }
    );
  }
}