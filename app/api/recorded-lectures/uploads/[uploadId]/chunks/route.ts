import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { uploadErrorResponse } from "@/lib/recorded-lectures/upload-errors";
import { uploadRecordingChunk } from "@/services/recorded-lecture-chunk-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One chunk of a recorded-lecture upload (Recorded Lectures RL-3.3).
 *
 *   PUT /api/recorded-lectures/uploads/[uploadId]/chunks
 *   Upload-Offset: <bytes already received>
 *   Content-Length: <chunk bytes>
 *   Content-Type: application/octet-stream
 *
 * OUTSIDE the middleware matcher on purpose: Next.js 14.2 buffers the whole
 * body of a request that passes the middleware; here the body streams
 * straight to disk (services/recorded-lecture-chunk-service.ts). The teacher
 * is authenticated here, before the body is read. 200 with the progress and
 * an Upload-Offset header; errors carrying the server's offset send it too.
 */
export async function PUT(request: Request, context: { params: { uploadId: string } }) {
  try {
    const session = await requireTeacherSession();
    const accepted = await uploadRecordingChunk({
      teacherId: session.teacherId,
      uploadId: context.params.uploadId,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    });
    const response = apiSuccess(accepted);
    response.headers.set("Upload-Offset", String(accepted.receivedBytes));
    return response;
  } catch (error) {
    return uploadErrorResponse(error, request);
  }
}
