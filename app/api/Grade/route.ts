import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function GET() {
  try {
    const grades = await prisma.grade.findMany({
      
    });

    console.log("GRADE API - Total grades:", grades.length);
    console.log("GRADE API - Grades:", grades);

    return NextResponse.json(grades);

    return NextResponse.json(grades);
  } catch (error) {
    return NextResponse.json(
      { message: "Failed to retrieve grades",error },
      { status: 500 }
    );
  }
}