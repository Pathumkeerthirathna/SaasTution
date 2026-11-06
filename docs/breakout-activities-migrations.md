# Breakout activities: the manual partial index

Read this before you create, edit or review any Prisma migration, and before you upgrade Prisma.

## What it is

Only one submission per student per breakout assignment can be the latest. The database enforces this with a **partial unique index**:

```sql
CREATE UNIQUE INDEX "BreakoutAssignmentSubmission_one_latest_key"
  ON "BreakoutAssignmentSubmission" ("assignmentId", "studentId")
  WHERE "isLatest";
```

- **Where it lives:** Prisma 5.22 can't express partial indexes in `schema.prisma`. So the statement exists **only** in the migration `prisma/migrations/20261105120000_add_breakout_activities/migration.sql`. It was added by hand at the end of the generated SQL.
- **Why it matters:** the application code (the submission transaction under an advisory lock) already keeps exactly one latest row. The index is the database backstop: if a bug ever tried to make a second row latest, the insert fails instead of corrupting the data.
- **The column stays as it is:** `isLatest` is `Boolean @default(true)` and NOT NULL. A submission flow sets the previous latest row to `false`, then inserts the new row with `true`, in one transaction. Don't turn the column into a nullable marker.

## The risk

Prisma doesn't know this index exists. When it compares the database (or the migration history) with `schema.prisma`, it may treat the index as drift. It might then:

- write `DROP INDEX "BreakoutAssignmentSubmission_one_latest_key";` into a **new** migration created by `prisma migrate dev`;
- report drift, and offer to **reset** the database.

Neither must ever be accepted.

## Rules

1. **Never** remove or edit the `CREATE UNIQUE INDEX` statement above, or that migration.
2. **Before committing any new migration**, check it doesn't touch the index or the column:
   ```bash
   grep -n -E 'one_latest_key|"isLatest"' prisma/migrations/*/migration.sql
   ```
   The only hits allowed are in `20261105120000_add_breakout_activities`. If a new migration contains `DROP INDEX "BreakoutAssignmentSubmission_one_latest_key"`, delete that statement before committing. Also check that nothing else the migration does depends on it.
3. **Never** accept a `prisma migrate dev` offer to reset a shared database: the testing (Neon) or production one. Apply migrations to shared databases only with `prisma migrate deploy`.
4. **Don't use `prisma db push`** on any database that has this index.
5. Run `npm run test:breakout`. `tests/breakout-activities/migration-guard.test.cjs` fails if:
   - the index statement is missing or changed;
   - any migration drops or renames it;
   - any migration drops or alters `"isLatest"`;
   - `isLatest` in the schema stops being `Boolean @default(true)`.

## Checking a database

After applying migrations to any database, check that the index is there:

```sql
SELECT indexdef FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'BreakoutAssignmentSubmission_one_latest_key';
```

Expected: one row, `CREATE UNIQUE INDEX … ("assignmentId", "studentId") WHERE "isLatest"`.

## Checking what Prisma would generate (drift check)

To see whether Prisma would try to drop the index, diff the migration history against the schema:

```bash
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --script
```

- **Shadow database:** `migrate diff --from-migrations` needs an **empty, disposable** one, which Prisma wipes. Never point `--shadow-database-url` at the Neon testing database or the production database.
- **Expected output:** no `DROP INDEX "BreakoutAssignmentSubmission_one_latest_key"`, ideally an empty migration. If the drop appears, Prisma does treat the index as drift: every future `migrate dev` will try to drop it, and rule 2 is what stops it.

Run the drift check:
- when a shadow database is available;
- after every Prisma upgrade.

## Prisma upgrades

- **7.4:** added partial-index support in the schema as a preview feature (`partialIndexes`).
- **7.5:** fixed manual partial indexes being dropped as drift when that preview is off.

When upgrading Prisma:

1. Read the release notes for index or drift changes.
2. Run the drift check above.
3. If partial indexes become supported in the schema, declare this index there with the same name and definition. The schema then describes it and the drift risk ends. Update this document and the guard test at the same time.

## Group Activities: the second manual partial index

Migration `prisma/migrations/20261106120000_add_breakout_group_activities/migration.sql` adds a second hand-written partial unique index. It follows every rule above.

```sql
CREATE UNIQUE INDEX "BreakoutRoomMember_one_active_key"
  ON "BreakoutRoomMember" ("classSessionId", "studentId")
  WHERE "status" = 0;
```

- **What it enforces:** a student has at most one **active** (`status = 0`) Group Activities membership per class session, so they belong to one breakout-room group at a time. Removed memberships (`status = 1`) stay as history and are not constrained.
- **Where it lives:** only in that migration's SQL, at the end, added by hand. Never in `schema.prisma`; the `BreakoutRoomMember` model comment names it.
- **The column stays as it is:** `status` is `Int @default(0)`, NOT NULL. Moving a student to another group sets the old row to `status = 1` before the new active row is inserted, in one transaction.
- **Guard:** `tests/breakout-activities/group-migration-guard.test.cjs` fails if the statement is missing or changed, if any migration drops or alters it, or if the migration stops being additive.
- **Drift:** the drift check above also applies. Expect no `DROP INDEX "BreakoutRoomMember_one_active_key"`.
