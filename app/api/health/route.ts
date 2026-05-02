import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";

export async function GET() {
  try {
    return apiSuccess(
      {
        status: "ok",
        timestamp: new Date().toISOString(),
      },
      { message: "Service is healthy." }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
