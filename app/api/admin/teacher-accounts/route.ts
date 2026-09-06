import { apiSuccess } from "@/lib/api-response";
import { requireAdminSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import {
  listTeacherAccountsForAdmin,
  TeacherRegistrationDateFilter,
} from "@/services/admin-teacher-service";

const DATE_FILTERS: TeacherRegistrationDateFilter[] = [
  "ALL",
  "MONTH",
  "QUARTER",
  "YEAR",
];

const DEFAULT_PAGE_SIZE = "5";

export async function GET(request: Request) {
  try {
    await requireAdminSession();

    const { searchParams } = new URL(request.url);

    if (!searchParams.has("pageSize")) {
      searchParams.set("pageSize", DEFAULT_PAGE_SIZE);
    }

    const pagination = parsePaginationParams(searchParams);

    const search = searchParams.get("search")?.trim() || undefined;

    const rawDateFilter = searchParams.get("dateFilter");
    const dateFilter = DATE_FILTERS.includes(
      rawDateFilter as TeacherRegistrationDateFilter
    )
      ? (rawDateFilter as TeacherRegistrationDateFilter)
      : "ALL";

    const { teachers, totalItems } = await listTeacherAccountsForAdmin({
      skip: pagination.skip,
      take: pagination.take,
      search,
      dateFilter,
    });

    return apiSuccess(
      { teachers },
      {
        pagination: buildPaginationMeta(
          totalItems,
          pagination.page,
          pagination.pageSize
        ),
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
