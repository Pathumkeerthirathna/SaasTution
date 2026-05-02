import type { ApiResponseBody } from "@/lib/api-types";
import { request } from "@/services/api-client";

export type UserDto = {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
};

export async function getUsers(page = 1, pageSize = 10): Promise<ApiResponseBody<UserDto[]>> {
  return request<UserDto[]>(`/api/users?page=${page}&pageSize=${pageSize}`);
}

export async function createUser(payload: {
  email: string;
  name?: string;
}): Promise<ApiResponseBody<UserDto>> {
  return request<UserDto>("/api/users", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
