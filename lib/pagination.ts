import type { PaginationMeta } from "@/lib/api-types";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

export type PaginationQuery = {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
};

function toPositiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.floor(parsed);
}

export function parsePaginationParams(searchParams: URLSearchParams): PaginationQuery {
  const page = toPositiveInt(searchParams.get("page"), DEFAULT_PAGE);
  const rawPageSize = toPositiveInt(searchParams.get("pageSize"), DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(rawPageSize, MAX_PAGE_SIZE);

  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize,
  };
}

export function buildPaginationMeta(totalItems: number, page: number, pageSize: number): PaginationMeta {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  return {
    page,
    pageSize,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}
