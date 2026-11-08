import { renderStudentQrPng, studentQrErrorResponse, withNoStore } from "@/lib/student-qr-http";
import { requireTeacherOwnedStudent } from "@/lib/teacher-student-access";
import { getActiveToken } from "@/services/student-qr-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/students/[id]/qr — the QR code (PNG) of a student the signed-in
 * teacher owns (401 without a teacher session; 404 for an unknown student or
 * another teacher's). READ-ONLY: never issues a QR; without one it answers
 * 404 QR_TOKEN_NOT_FOUND (issue it with POST /api/students/[id]/qr/issue). `?download=1` only switches
 * the response to an attachment; the token is never part of any URL.
 * Private and no-store.
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const { teacherId, studentId } = await requireTeacherOwnedStudent(context.params?.id);
    const qr = await getActiveToken(studentId, { role: "TEACHER", id: teacherId });
    const png = await renderStudentQrPng(qr.payload);

    const download = new URL(request.url).searchParams.get("download") === "1";
    return withNoStore(
      new Response(new Uint8Array(png), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(png.length),
          "Content-Disposition": `${download ? "attachment" : "inline"}; filename="student-qr-code.png"`,
        },
      })
    );
  } catch (error) {
    return studentQrErrorResponse(error, request);
  }
}
