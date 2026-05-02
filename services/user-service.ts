import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

type ListUsersParams = {
  skip: number;
  take: number;
};

export async function listUsers(params: ListUsersParams) {
  const [users, totalItems] = await Promise.all([
    prisma.teacher.findMany({
      skip: params.skip,
      take: params.take,
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
      },
    }),
    prisma.teacher.count(),
  ]);

  return {
    users,
    totalItems,
  };
}

export async function createUser(email: string, name?: string) {
  const temporaryPasswordHash = await bcrypt.hash(crypto.randomUUID(), 12);

  return prisma.teacher.create({
    data: {
      email,
      name: name ?? "Teacher",
      password: temporaryPasswordHash,
    },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
    },
  });
}
