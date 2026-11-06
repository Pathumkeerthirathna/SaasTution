// Group Activities isolation: the existing INDIVIDUAL student services must
// never show or accept a GROUP activity (those belong to the group services:
// services/breakout-group-*.ts).
//
//  - Reads filter with INDIVIDUAL_ONLY in their own query (no extra query).
//  - Writes call assertNotGroupActivity() once, BEFORE their transaction.
//    That is safe outside the transaction because an activity's workMode is
//    fixed at creation and never changes (no update path writes it), and it
//    keeps the existing in-transaction lock order and queries unchanged.
// A GROUP activity answers the same 404 as any activity a student cannot see.

import { prisma } from "@/lib/prisma";

import { breakoutError } from "../errors";

/** Prisma filter for the existing individual services: anything but GROUP (INDIVIDUAL). */
export const INDIVIDUAL_ONLY = { not: "GROUP" } as const;

/**
 * 404 `notFoundCode` when the activity exists and is a GROUP activity;
 * otherwise nothing (a missing id is left to the caller's own checks).
 * `activityId` must already be a validated route id.
 */
export async function assertNotGroupActivity(
  kind: "assignment" | "quiz",
  activityId: string,
  notFoundCode: "ASSIGNMENT_NOT_FOUND" | "QUIZ_NOT_FOUND"
): Promise<void> {
  const row =
    kind === "assignment"
      ? await prisma.breakoutAssignment.findUnique({ where: { id: activityId }, select: { workMode: true } })
      : await prisma.breakoutQuiz.findUnique({ where: { id: activityId }, select: { workMode: true } });
  if (row?.workMode === "GROUP") throw breakoutError(notFoundCode);
}
