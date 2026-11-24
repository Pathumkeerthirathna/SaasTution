# Default lecture

Every class has one internal **default lecture** (`Lecture.isDefault = true`, titled "General Notes"). It holds class-level content for the upcoming Notes module. It is **not a teaching session**.

## Rules

- **One per class.** The partial unique index `"Lecture_one_default_per_class"` on `("classId") WHERE "isDefault" = true` enforces this. It comes from migration `20261129120000_add_lecture_is_default` and is hand-written, because Prisma 5.22 cannot declare partial indexes.
- **Created with the class.** `createClassForTeacher` (`services/class-service.ts`) creates it in the same transaction as the class. If the lecture can't be created, the class rolls back as well. Editing a class never creates one.
  - `date`: the creation instant, a real UTC instant like every `Lecture.date`.
  - `endDate`: `NULL`.
- **Never created by the normal lecture APIs.** The request schemas strip `isDefault`, and the services never set it, so new lectures get the column default, `false`.
- **Identified only by `isDefault`.** Never by title or date.

## Isolation

- **Lists and counts.** Every Lecture list or count query in `app/`, `services/` and `lib/` spreads `NORMAL_LECTURE_WHERE` (`lib/default-lecture.ts`). This covers:
  - teacher and student lecture lists, selectors and the lecture detail page;
  - the attendance overview and matrix;
  - calendar, countdowns and dashboard counts;
  - attendance percentages, the attendance gap report and backfill, and fee-waiver lecture counts;
  - assignment and quiz filters, and public class sessions.
- **Single-lecture workflows answer 404 `LECTURE_NOT_FOUND`.** These are:
  - lecture update, status and delete;
  - the attendance register, QR scans and closure, decisions, history, finalization and reconciliation;
  - live sessions, YouTube live/recording, recorded-lecture uploads, whiteboards, quizzes and assignments.
- **Attendance also checks centrally, under the lecture lock.** `inspectLectureForAttendance` treats a default lecture as not found. No register, record or scan can ever be written for it.
- **The note workflow is unchanged and accepts it.** That is `assertTeacherOwnsLecture(..., { includeDefault: true })` in the lecture note APIs and the student lecture-notes route.
- **The guard.** `tests/lectures/default-lecture.test.cjs` fails if a new Lecture list or count lacks the filter. It also fails if a new unfiltered single-lecture call appears that has not been reviewed.

## Deployment order

1. Apply migration `20261129120000_add_lecture_is_default`. It adds the column (`NOT NULL DEFAULT false`, no table rewrite) and the index, with **no backfill**.
2. Run `npx prisma generate`, then deploy the code.
3. Review `docs/sql/default-lecture-backfill.sql`, then run it by hand with psql. It creates one default lecture for every existing class that lacks one and can safely be run more than once. Run the two check queries in its header afterwards.

Until step 3 runs, existing classes have no default lecture. Nothing depends on one yet.

## Tests

| Command | What it checks |
|---|---|
| `npm run test:lectures` | Unit tests, the static guard and the migration guard |
| `npm run test:attendance` | `tests/attendance/default-lecture-attendance.test.cjs`: QR, register, decisions and online evidence |
| `npm run test:default-lecture-db` | On a throwaway local PostgreSQL: the index, atomic class creation and the backfill script. Opt-in; see the file header |
