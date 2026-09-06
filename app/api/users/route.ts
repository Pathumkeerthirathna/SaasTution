import { apiSuccess } from "@/lib/api-response";
import { requireAdminSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { createUser, listUsers } from "@/services/user-service";

export async function GET(request: Request) {
  try {
    await requireAdminSession();

    const { searchParams } = new URL(request.url);
    const pagination = parsePaginationParams(searchParams);

    const { users, totalItems } = await listUsers({
      skip: pagination.skip,
      take: pagination.take,
    });

    return apiSuccess(users, {
      pagination: buildPaginationMeta(totalItems, pagination.page, pagination.pageSize),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdminSession();

    const body = (await request.json()) as {
      email?: string;
      name?: string;
    };

    if (!body.email?.trim()) {
      throw new AppError("Email is required.", 400, "VALIDATION_ERROR");
    }

    const user = await createUser(body.email.trim(), body.name?.trim());

    return apiSuccess(user, {
      status: 201,
      message: "User created successfully.",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
