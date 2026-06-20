import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function GET() {
  try {
    const grades = await prisma.grade.findMany({
      
    });

    return NextResponse.json(grades);
  } catch (error) {
    return NextResponse.json(
      { message: "Failed to retrieve grades",error },
      { status: 500 }
    );
  }
}