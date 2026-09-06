import { prisma } from "@/lib/prisma";

/**
 * A teacher whose account is still pending admin review has no real
 * dashboard data yet. Rather than showing an empty/loading dashboard, the
 * exact same dashboard components are fed this sample data instead, so the
 * teacher can see what their workspace will look like once confirmed.
 */
export async function isTeacherPendingConfirmation(
  teacherId: string
): Promise<boolean> {
  const teacher = await prisma.teacher.findUnique({
    where: { id: teacherId },
    select: { isConfirmed: true, isRejected: true },
  });

  if (!teacher) return false;

  return !teacher.isConfirmed && !teacher.isRejected;
}

export function getDummyDashboardMetrics() {
  return {
    lectures: { scheduled: 5, total: 8 },
    events: { pending: 2, total: 4 },
    materials: { pendingToSend: 1, total: 5 },
    papers: { notReviewed: 2, total: 5 },
    bundlePapers: { notReviewed: 1, total: 3 },
    assignments: { notReviewed: 3, total: 6 },
  };
}

export function getDummyCoursework() {
  const now = new Date().toISOString();

  return {
    assignments: [
      {
        id: "demo-assignment-1",
        title: "Mechanics Assignment 3",
        dueDate: now,
        className: "Combined Maths — Grade 12",
        lectureTitle: "Mechanics Revision",
        submissions: [
          {
            id: "demo-sub-1",
            studentName: "Nimal Perera",
            registrationNumber: "ST20260014",
            submittedAt: now,
            hasFile: true,
          },
          {
            id: "demo-sub-2",
            studentName: "Kavindi Silva",
            registrationNumber: "ST20260021",
            submittedAt: now,
            hasFile: false,
          },
        ],
      },
    ],
    quizzes: [
      {
        id: "demo-quiz-1",
        title: "Unit 4 Quiz",
        className: "Physics — Grade 11",
        totalQuestions: 10,
        submissions: [
          {
            id: "demo-qsub-1",
            studentName: "Sachini Fernando",
            registrationNumber: "ST20260033",
            submittedAt: now,
            score: 8,
            totalQuestions: 10,
            attemptCount: 1,
          },
        ],
      },
    ],
  };
}

export function getDummyPaperReviews() {
  const now = new Date().toISOString();

  return [
    {
      submissionId: "demo-paper-submission-1",
      submittedAt: now,
      studentName: "Kavindi Silva",
      registrationNumber: "ST20260021",
      paperId: "demo-paper-1",
      paperName: "Mechanics Paper 2",
      startTime: now,
      endTime: now,
      classId: "demo-class-1",
      className: "Combined Maths — Grade 12",
    },
  ];
}

export function getDummyBundlePaperReviews() {
  const now = new Date().toISOString();

  return [
    {
      submissionId: "demo-bundle-paper-submission-1",
      submittedAt: now,
      studentName: "Sachini Fernando",
      registrationNumber: "ST20260033",
      itemId: "demo-bundle-item-1",
      paperName: "Unit 4 Structured Paper",
      startTime: now,
      endTime: now,
      bundleId: "demo-bundle-1",
      bundleName: "September Tutes & Papers",
      classId: "demo-class-2",
      className: "Physics — Grade 11",
    },
  ];
}

export function getDummyCalendarEntries() {
  const dateStr = new Date().toISOString().slice(0, 10);

  return [
    {
      key: "demo-schedule-1",
      date: dateStr,
      startTime: "09:00",
      endTime: "10:30",
      kind: "schedule" as const,
      classId: "demo-class-1",
      className: "Combined Maths — Grade 12",
      scheduled: true,
      lecture: { id: "demo-lecture-1", title: "Mechanics Revision", status: "0" },
      eventId: null,
      eventTypeName: null,
      color: null,
      description: null,
      isAllDay: false,
      location: null,
      meetingUrl: null,
    },
    {
      key: "demo-event-1",
      date: dateStr,
      startTime: "16:00",
      endTime: "17:00",
      kind: "event" as const,
      classId: null,
      className: "Parent-Teacher Meeting",
      scheduled: false,
      lecture: null,
      eventId: 1,
      eventTypeName: "Meeting",
      color: "#6366f1",
      description: null,
      isAllDay: false,
      location: "Zoom",
      meetingUrl: null,
    },
  ];
}
