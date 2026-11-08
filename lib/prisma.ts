import { PrismaClient } from "@prisma/client";

import { formatPrismaLogEvent } from "@/lib/error-logging/sanitize";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

/**
 * Prisma's default "error" / "warn" console output prints code frames, query
 * arguments (student names, phone numbers) and PostgreSQL DETAIL lines with
 * whole rows (e.g. a StudentQrToken's nonce and tokenHash). The client emits
 * them as events instead, and only a sanitized one-line summary (operation,
 * error codes, SQL identifiers, the problem statement) reaches the console.
 * Thrown errors are unchanged; route logs sanitize them separately.
 */
function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: [
      { emit: "event", level: "error" },
      { emit: "event", level: "warn" },
    ],
  });

  client.$on("error", (event) => console.error(formatPrismaLogEvent("error", event)));
  client.$on("warn", (event) => console.warn(formatPrismaLogEvent("warn", event)));

  return client as unknown as PrismaClient;
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
