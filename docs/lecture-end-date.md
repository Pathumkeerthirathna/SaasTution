# Lecture end time (`Lecture.endDate`)

A lecture may have an optional scheduled end time. It is used later by the
attendance register (finalization is allowed once the scheduled end has
passed); nothing else depends on it yet.

## Rules

- `endDate` is a real UTC instant, like `date`. Teachers enter and see both in
  Sri Lankan time (Asia/Colombo): a timezone-less `YYYY-MM-DDTHH:MM` value is
  read as Sri Lankan time (`lib/lecture-validation.ts`, the same rule as `date`).
- Optional. `null` (or an empty form field) means "no end time"; sending
  `endDate: null` clears a stored one; omitting it leaves it unchanged.
- Strictly after the start, and at most 12 hours after it
  (`lib/lecture-schedule.ts`, shared by validation, the service and the form).
- When only one side changes, it is checked against the stored other side
  (`updateLectureForTeacher`). A start change that no longer fits the stored
  end is refused (`400 LECTURE_END_NOT_AFTER_START` / `LECTURE_TOO_LONG`); the
  end is never cleared silently.
- Database: CHECK constraint `Lecture_endDate_after_date`
  (`"endDate" IS NULL OR "endDate" > "date"`). The 12-hour maximum is an
  application rule only.
- Existing lectures keep `endDate = NULL`. There is no backfill (in particular
  none from `ClassSchedule`, which is a weekly template, not per-lecture data).
- Fee waivers use `date` only and are unaffected.

## Migration

`prisma/migrations/20261110120000_add_lecture_end_date/migration.sql` adds the
nullable column and the hand-written CHECK constraint. Additive only; guarded
by `tests/lectures/lecture-end-date-migration-guard.test.cjs`.

### Applying it (not done yet)

Applying this migration is a **separate operation that needs explicit
approval**. Nothing in this document runs it.

- **Neon testing database first.** Production only after review, with its own
  approval.
- **Migrations only.** Never `prisma db push`: it does not create the CHECK
  constraint.
- **Direct connection only.** Prisma Migrate (`migrate status` and
  `migrate deploy`) must use Neon's **direct, non-pooled** connection. The
  **pooled** connection (host containing `-pooler`, PgBouncer in transaction
  mode) must **not** be used for Prisma Migrate. Migrate relies on a
  session-level advisory lock, which a transaction-mode pooler does not keep
  on one server connection.
- **The project's `.env` holds the pooled connection,** so running the
  migration commands as they are would use it. Do not edit `.env` to change
  this. The full procedure (choosing the direct connection, checking the
  target, the migration order and the checks afterwards) is in
  [student-confirmation-history.md](student-confirmation-history.md#applying-the-migrations-on-neon-testing).

This migration (`20261110120000_add_lecture_end_date`) is applied **first**,
before `20261110130000_add_student_confirmation_history`.

After applying, check that the constraint exists:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = '"Lecture"'::regclass AND conname = 'Lecture_endDate_after_date';
```

`ADD CONSTRAINT ... CHECK` scans the `Lecture` table once under a brief
exclusive lock; every existing row has `endDate` NULL, so it always passes.
