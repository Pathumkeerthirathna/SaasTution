# PostgreSQL validation: Free Card and payment access control migrations

Migrations covered:

- `20261120120000_add_class_student_fee_free_card`: adds `ClassStudentFee.freeCard`, `freeCardIssuedAt` and `freeCardIssuedByTeacherId`, plus an index, a foreign key and 2 CHECK constraints.
- `20261121120000_add_class_payment_access_control`: adds `Class.restrictUnpaidStudentAccess` and `paymentGracePeriodDays`, plus 1 CHECK constraint.

Both migrations are additive. Each starts with `SET lock_timeout = '5s'` and ends with `RESET lock_timeout`. Run nothing below without approval for that environment: Neon testing first, then production.

## Already done (local, no shared database)

- [x] Static guard tests:
  - [x] `tests/fee-waiver/free-card-migration-guard.test.cjs` and `tests/class-access/class-access-migration-guard.test.cjs` check the exact statements, the additive-only shape, `SET`/`RESET lock_timeout`, and that no `SET LOCAL` is used.
  - [x] The migration-order guards in 8 other suites list both migrations as approved.
- [x] Offline `prisma migrate diff` (no database) matches `schema.prisma` for both migrations.
- [x] **Free Card only:** applied on a throwaway local PostgreSQL 18 on 2026-11-17, before `RESET lock_timeout` was added (the statements are otherwise identical). Results:
  - [x] existing rows got `freeCard = false` with NULL issue details, and no other value changed;
  - [x] both CHECK constraints and the foreign key rejected the bad updates and accepted the good ones;
  - [x] `migrate diff --from-url` against `schema.prisma` reported an empty migration (no drift).
- [x] Concurrency was simulated only with the in-memory fake, which has no real locks:
  - [x] payment upload racing a card issue;
  - [x] a card issued between an automatic recalculation's read and its write;
  - [x] a manual adjustment racing a card issue.

  Both raw lock queries were executed once on the local PostgreSQL. **No two-session test has been run.**

## Outstanding

### 1. Target and order

- [ ] Confirm the target host is Neon testing, not production.
- [ ] Use a **direct** (non-pooler) connection for every Prisma CLI command. Pooled connections are generally not recommended for migrations.
- [ ] Run `npx prisma migrate status`. Pending migrations must end with `...20261120120000_add_class_student_fee_free_card` and then `...20261121120000_add_class_payment_access_control`.
- [ ] If earlier migrations are also pending (`20261115120000` to `20261119120000`), set their environment variables first: `FILE_STORAGE_ROOT`, `EMAIL_PAYLOAD_ENCRYPTION_KEY`, and optionally `UNIFIED_STORAGE_LEGACY_DUAL_WRITE`. Decide whether to apply everything with `prisma migrate deploy`, or only these two with `prisma db execute` followed by `prisma migrate resolve --applied`.

### 2. Before applying

- [ ] Record row counts: `SELECT count(*) FROM "ClassStudentFee"` and `SELECT count(*) FROM "Class"`.
- [ ] Check for long transactions holding locks on `"ClassStudentFee"`, `"Teacher"` or `"Class"`. The 5-second lock timeout makes the migration fail rather than queue behind them.

### 3. After applying

- [ ] Columns and defaults: query `information_schema.columns` for the 5 new columns and confirm their types, NOT NULL and the defaults `false` / `5`.
- [ ] Existing data untouched:
  - [ ] `SELECT count(*) FROM "ClassStudentFee" WHERE "freeCard"` returns 0;
  - [ ] `SELECT count(*) FROM "Class" WHERE "restrictUnpaidStudentAccess" OR "paymentGracePeriodDays" <> 5` returns 0;
  - [ ] the row counts match step 2.
- [ ] Constraints present, by querying `pg_constraint`:
  - [ ] `ClassStudentFee_freeCard_finalAmount_check`
  - [ ] `ClassStudentFee_freeCard_issued_check`
  - [ ] `ClassStudentFee_freeCardIssuedByTeacherId_fkey` (ON DELETE SET NULL)
  - [ ] `Class_paymentGracePeriodDays_check`
  - [ ] index `ClassStudentFee_freeCardIssuedByTeacherId_idx`
- [ ] Each constraint rejects its bad case. Run inside `BEGIN … ROLLBACK`:
  - [ ] a card with `finalAmount > 0`;
  - [ ] issue details left on a row with `freeCard = false`;
  - [ ] a grace period of -1 or 31;
  - [ ] an unknown teacher id.
- [ ] `SHOW lock_timeout` in the migrating session afterwards shows the default.
- [ ] No drift: `prisma migrate diff --from-url <direct url> --to-schema-datamodel prisma/schema.prisma` reports an empty migration. This uses no shadow database.
- [ ] `npx prisma generate`, then restart the app.

### 4. Rollback behaviour

- [ ] A failure partway through a migration rolls the whole migration back, because the script runs as one implicit transaction. Check `migrate status` (a failed migration needs `prisma migrate resolve --rolled-back <name>`, which requires approval).
- [ ] Manual removal is never run without approval. Revert the application code first, then drop the constraints, index and columns in reverse order:
  - [ ] Payment access: drop `Class_paymentGracePeriodDays_check`, then the 2 `Class` columns.
  - [ ] Free Card: drop the 2 CHECKs and the FK, then the index, then the 3 columns.

  This **loses** issued Free Cards and class settings. Rows that had a card keep `finalAmount = 0` until they are reprocessed.

### 5. Concurrency (two psql sessions, Neon testing only)

- [ ] **Upload vs issue.** Session A: `BEGIN; SELECT "freeCard" FROM "ClassStudentFee" WHERE id=$1 FOR UPDATE;`. Session B runs the same lock and must wait. After A inserts a payment and commits, B must see the payment, which is the "skip as pending" path.
- [ ] **Two overlapping bulk issues.** Two requests for overlapping fee sets must not deadlock, because locks are taken in sorted id order. One processes each fee, and the other reports it as `ALREADY_FREE_CARD`.
- [ ] **Card vs automatic recalculation.** Issue a card while a Reprocess or class fee change runs. The card must survive with `finalAmount = 0`.
- [ ] **Lock timeout.** Hold a fee row lock for more than 3 seconds. The bulk issue must answer 409 `FREE_CARD_BUSY`, and nothing may change.

### 6. Payment access control on PostgreSQL

- [ ] **Grace boundary in Sri Lanka time.** Due 10 Nov with 5 days' grace: access is allowed on 15 Nov at 23:59 and restricted from 16 Nov at 00:00. Use a test class.
- [ ] **Automatic restoration**, with no job: a slip submission, a Free Card, an adjustment to 0, or switching the setting off.
- [ ] **Query cost.** Run `EXPLAIN ANALYZE` on the restriction query (`getClassAccessRestrictions`) for a student with many fees. It filters `ClassStudentFee` by enrolment, through the existing `classStudentId` index.
- [ ] **Smoke test**, on one class:
  - [ ] turning the setting on shows the earlier-months warning;
  - [ ] a restricted student sees the notice and gets a 403 on content;
  - [ ] payments still work;
  - [ ] a second class is unaffected.


## Partial payments (Stage 2A): historical data audit, read-only

Stage 2A shows each fee's genuine balance: received means confirmed, not reversed payments, and outstanding is `max(0, finalAmount - received)`. Historical fees whose confirmed slip does not equal today's `finalAmount` therefore change from "Paid" to "Partial" or are reported as overpaid.

**How they can arise (from the code):** a slip records `finalAmount` when it is uploaded (`app/api/student/payments/route.ts`). Until it is confirmed, the fee can still change:
- the class fee changes (`setMonthlyFeeAmount`, and the current-month sync in `processCurrentMonthFees`);
- a manual discount, late-join deduction or waiver is applied (`updateStudentFeeAdjustment`);
- the automatic joining-waiver recalculation runs.

After confirmation the fee is frozen. A fee raised while a slip was pending becomes **underpaid**; a fee lowered becomes **overpaid**.

These counts are **not known**: no database was queried. Run the queries on Neon testing, then production, each with approval. Before migration `20261122120000` there is no `ClassPaymentReversal` table, so drop its join (nothing is reversed yet).

```sql
-- Fees with a confirmed payment whose confirmed total differs from finalAmount.
SELECT f."id", f."year", f."month", f."finalAmount", f."status", f."freeCard",
       SUM(p."amount") FILTER (WHERE p."status" = 'CONFIRMED' AND r."id" IS NULL) AS "confirmedTotal",
       COUNT(*)       FILTER (WHERE p."status" = 'CONFIRMED') AS "confirmedCount"
FROM "ClassStudentFee" f
JOIN "ClassPayment" p ON p."classStudentFeeId" = f."id"
LEFT JOIN "ClassPaymentReversal" r ON r."paymentId" = p."id"
GROUP BY f."id"
HAVING BOOL_OR(p."status" = 'CONFIRMED')
   AND COALESCE(SUM(p."amount") FILTER (WHERE p."status" = 'CONFIRMED' AND r."id" IS NULL), 0) <> f."finalAmount"
ORDER BY f."year", f."month";
-- confirmedTotal < finalAmount: now PARTIAL (underpaid); > finalAmount: overpaid.
-- status = 1 rows in this list are re-flagged by the next Reprocess (1 only when fully paid).

-- Fees with more than one confirmed payment (should not exist before Stage 2B).
SELECT "classStudentFeeId", COUNT(*) FROM "ClassPayment"
WHERE "status" = 'CONFIRMED' GROUP BY "classStudentFeeId" HAVING COUNT(*) > 1;
```

Decide how to treat each underpaid or overpaid fee before or after the release: accept the balance, record the difference, or correct it through the normal workflow.
