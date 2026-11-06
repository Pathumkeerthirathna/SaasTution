# Student registration number: partial unique index

`Student.registrationNumber` must be unique across **all teachers** among students
that are **not deleted** (`status` 0 = active, 1 = inactive). A deleted student
(`status` 2) keeps its number on its own row — its attendance, payments and other
history stay attached to its `id` — but the number may be given to a new student.

The database enforces this with a hand-written partial unique index:

```sql
CREATE UNIQUE INDEX "Student_registrationNumber_not_deleted_key"
  ON "Student" ("registrationNumber")
  WHERE "status" <> 2;
```

created by `prisma/migrations/20261106150000_student_registration_number_not_deleted_unique`.

## Why it is not in schema.prisma

Prisma 5.22 cannot declare partial indexes. `schema.prisma` therefore keeps
`registrationNumber String?` **without** `@unique` (adding `@unique` would make
deleted numbers non-reusable), and the index lives only in the migration SQL.

## Rules for future migrations

`prisma migrate dev` / `prisma migrate diff` compare the schema with the
database and will see this index as drift. They may generate

```sql
DROP INDEX "Student_registrationNumber_not_deleted_key";
```

in a new migration. **Before committing any generated migration, check it with
`prisma migrate diff` / by reading the SQL and delete any such statement.**
Never edit the creating migration after it has been applied.

`tests/students/registration-number-migration-guard.test.cjs` (`npm run test:students`)
fails if any migration drops, alters or recreates the index, changes the
`status` / `registrationNumber` columns, or if `schema.prisma` gains a
`@unique` on `registrationNumber`.

## Application code

The same rule is applied in code (`services/student-service.ts`:
`isRegistrationNumberTaken`, `generateAvailableRegistrationNumbers`,
`normalizeRegistrationNumber`, `isRegistrationNumberConflict`). The index is the
backstop for concurrent registrations: a conflicting write fails with Prisma
`P2002`, which the add / edit / public registration / CSV import paths turn into
"Registration number already exists" (or retry, for generated numbers).
