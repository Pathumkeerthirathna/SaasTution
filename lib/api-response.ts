import { NextResponse } from "next/server";

import type { ApiFailureBody, ApiSuccessBody, PaginationMeta } from "@/lib/api-types";

type SuccessOptions = {
  status?: number;
  message?: string;
  pagination?: PaginationMeta;
};

export function apiSuccess<T>(data: T, options: SuccessOptions = {}) {
  const body: ApiSuccessBody<T> = {
    success: true,
    data,
    message: options.message,
    pagination: options.pagination,
  };

  return NextResponse.json(body, { status: options.status ?? 200 });
}

export function apiError(message: string, status = 500, code?: string, details?: unknown) {
  const body: ApiFailureBody = {
    success: false,
    error: {
      message,
      code,
      details,
    },
  };

  return NextResponse.json(body, { status });
}
