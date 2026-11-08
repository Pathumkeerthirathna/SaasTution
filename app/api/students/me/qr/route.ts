import { requireStudentSession } from "@/lib/auth-session";
import { renderStudentQrPng, studentQrErrorResponse, withNoStore } from "@/lib/student-qr-http";
import { getActiveToken } from "@/services/student-qr-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/students/me/qr — the signed-in student's QR code as a PNG.
 * READ-ONLY: never issues a QR; without one it answers 404
 * QR_TOKEN_NOT_FOUND (issue it first with POST /api/students/me/qr/issue).
 * `?download=1` only switches the response to an
 * attachment; the token is never part of any URL. Private and no-store:
 * never kept by the browser cache, a proxy or a CDN.
 */
export async function GET(request: Request) {
  try {
    const session = await requireStudentSession();
    const qr = await getActiveToken(session.studentId, { role: "STUDENT", id: session.studentId });
    const png = await renderStudentQrPng(qr.payload);

    const download = new URL(request.url).searchParams.get("download") === "1";
    return withNoStore(
      new Response(new Uint8Array(png), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(png.length),
          "Content-Disposition": `${download ? "attachment" : "inline"}; filename="my-qr-code.png"`,
        },
      })
    );
  } catch (error) {
    return studentQrErrorResponse(error, request);
  }
}
