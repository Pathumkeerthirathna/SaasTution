import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { createMaterialBundleSchema, materialBundleQuerySchema } from "@/lib/material-bundle-validation";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { createMaterialBundleForTeacher, listMaterialBundlesForTeacher } from "@/services/material-bundle-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireTeacherSession();
    const { searchParams } = new URL(request.url);
    const pagination = parsePaginationParams(searchParams);

    const classId = searchParams.get("classId")?.trim();
    const year = searchParams.get("year")?.trim();
    const month = searchParams.get("month")?.trim();

    const parsedQuery = materialBundleQuerySchema.safeParse({
      classId,
      year: year || undefined,
      month: month || undefined,
    });

    if (!parsedQuery.success) {
      const firstIssue = parsedQuery.error.issues[0]?.message ?? "Invalid query parameters.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsedQuery.error.flatten());
    }

    const result = await listMaterialBundlesForTeacher({
      teacherId: session.teacherId,
      classId: parsedQuery.data.classId,
      year: parsedQuery.data.year,
      month: parsedQuery.data.month,
      skip: pagination.skip,
      take: pagination.take,
    });

    return apiSuccess(result.bundles, {
      pagination: buildPaginationMeta(result.totalItems, pagination.page, pagination.pageSize),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireTeacherSession();
    const body = (await request.json()) as {
      classId?: string;
      year?: number;
      month?: number;
    };

    const parsed = createMaterialBundleSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const bundle = await createMaterialBundleForTeacher(session.teacherId, parsed.data);

    return apiSuccess(
      { bundle },
      {
        status: 201,
        message: "Bundle created successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
