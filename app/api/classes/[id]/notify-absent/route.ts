import { NextRequest, NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { listStudentsForClassroom } from "@/services/student-service";
import { sendClassStartedNotifications } from "@/lib/mailer";

export async function POST(
    request: NextRequest,
    context: { params: { id: string } }
) {
    try {
        const teacherSession =
            await requireTeacherSession();

        const classId = context.params.id;

        if (!classId?.trim()) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Class id is required.",
                },
                { status: 400 }
            );
        }

        const body = await request.json();

        const studentIds: string[] =
            Array.isArray(body.studentIds)
                ? body.studentIds.filter(
                    (id: unknown) => typeof id === "string"
                )
                : [];

        const message =
            typeof body.message === "string"
                ? body.message.trim()
                : "";

        if (studentIds.length === 0) {
            return NextResponse.json(
                {
                    success: false,
                    error: "No students selected.",
                },
                { status: 400 }
            );
        }

        if (!message) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Message is required.",
                },
                { status: 400 }
            );
        }

        // Re-fetch students server-side (rather than trusting the emails
        // the client sent) so a teacher can only notify real students of a
        // class they actually own.
        const classStudents =
            await listStudentsForClassroom({
                teacherId: teacherSession.teacherId,
                classId,
            });

        const selectedIds = new Set(studentIds);

        const recipients = classStudents.filter(
            (student) => selectedIds.has(student.studentId)
        );

        if (recipients.length === 0) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        "None of the selected students belong to this class.",
                },
                { status: 400 }
            );
        }

        // Fire-and-forget: emails are sent one by one (with retries) inside
        // sendClassStartedNotifications, which can take a while for a large
        // class. We don't make the teacher's browser wait for that — the
        // batch keeps running in the background after this response is
        // sent, and every recipient is logged as it completes.
        void sendClassStartedNotifications(
            recipients,
            message
        ).catch((error) => {
            console.error(
                "❌ Class-started notification batch failed unexpectedly:",
                error
            );
        });

        return NextResponse.json({
            success: true,
            queued: recipients.length,
        });

    } catch (error) {
        console.error(
            "Notify absent students failed:",
            error
        );

        const message =
            error instanceof Error
                ? error.message
                : "Failed to notify absent students.";

        return NextResponse.json(
            {
                success: false,
                error: message,
            },
            { status: 500 }
        );
    }
}
