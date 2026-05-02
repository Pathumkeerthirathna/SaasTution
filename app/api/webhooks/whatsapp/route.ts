import { apiError, apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { messageDeliveryWebhookSchema } from "@/lib/message-validation";
import { updateMessageDeliveryStatus } from "@/services/message-service";

export const dynamic = "force-dynamic";

function isAuthorized(request: Request) {
  const configuredSecret = process.env.WHATSAPP_WEBHOOK_SECRET?.trim();

  if (!configuredSecret) {
    return false;
  }

  const incomingSecret = request.headers.get("x-webhook-secret")?.trim();
  return incomingSecret === configuredSecret;
}

export async function POST(request: Request) {
  try {
    if (!isAuthorized(request)) {
      return apiError("Unauthorized webhook request.", 401, "UNAUTHORIZED");
    }

    const body = (await request.json()) as {
      providerMessageId?: string;
      status?: "QUEUED" | "SENT" | "FAILED";
      error?: string;
    };

    const parsed = messageDeliveryWebhookSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid webhook payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const result = await updateMessageDeliveryStatus(parsed.data);

    return apiSuccess(result, {
      message: "Delivery status updated successfully.",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
