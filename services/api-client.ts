import type { ApiResponseBody } from "@/lib/api-types";

export async function request<T>(url: string, init?: RequestInit): Promise<ApiResponseBody<T>> {
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    const payload = (await response.json()) as ApiResponseBody<T>;

    if (!response.ok) {
      if ("error" in payload) {
        throw new Error(payload.error.message);
      }

      throw new Error("The request failed.");
    }

    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown network error.";

    return {
      success: false,
      error: {
        message,
        code: "REQUEST_FAILED",
      },
    };
  }
}
