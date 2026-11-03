import { developmentOnly, reportRouteError } from "@/lib/error-handler";
import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function GET(request: Request) {
  try {
    const grades = await prisma.grade.findMany({
      
    });

    console.log("GRADE API - Total grades:", grades.length);
    console.log("GRADE API - Grades:", grades);

    return NextResponse.json(grades);

    return NextResponse.json(grades);
  } catch (error) {
    reportRouteError(error, { request, statusCode: 500 });

    return NextResponse.json(
      { message: "Failed to retrieve grades", error: developmentOnly(error) },
      { status: 500 }
    );
  }
}