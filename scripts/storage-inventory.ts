/*
 * Unified storage migration, Stage 1: READ-ONLY inventory of the legacy
 * Notes and assignment-submission files. Entry point; see
 * scripts/storage-inventory-cli.ts and docs/storage-migration-inventory.md.
 *
 * Does not import lib/prisma (which would load .env): the client is loaded
 * only after the database URL, the confirmation and the roots were checked,
 * and the URL comes from STORAGE_INVENTORY_DATABASE_URL, never DATABASE_URL.
 */

import { runStorageInventoryCli } from "./storage-inventory-cli";

runStorageInventoryCli(process.argv.slice(2), {
  env: process.env,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  loadPrismaClient: async () => (await import("@prisma/client")).PrismaClient as never,
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    // Name only: a message could carry paths or connection details.
    console.error(`Storage inventory failed (${error instanceof Error ? error.name : "unknown error"}). Nothing was changed; re-running is safe.`);
    process.exitCode = 1;
  });
