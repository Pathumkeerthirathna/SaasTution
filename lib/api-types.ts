export type ApiErrorBody = {
  message: string;
  code?: string;
  details?: unknown;
};

export type ApiSuccessBody<T> = {
  success: true;
  data: T;
  message?: string;
  pagination?: PaginationMeta;
};

export type ApiFailureBody = {
  success: false;
  error: ApiErrorBody;
};

export type ApiResponseBody<T> = ApiSuccessBody<T> | ApiFailureBody;

export type PaginationMeta = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};
