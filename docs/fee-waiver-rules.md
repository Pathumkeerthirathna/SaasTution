# Automatic monthly joining fee waiver

Teachers configure sequential rules per class (Payments page → **Waiver Rules**).
For a Sri Lankan billing month, a student who joined during the month gets ONE
rule: rule N when N **COMPLETED** lectures of that class were held in the month
strictly before the student joined (the last rule when N is larger). Rules are
never added together. The amount is stored in `ClassStudentFee.lateJoinDeduct`
with a snapshot of the rule (`joinWaiver*` columns), so `computeFinalAmount`
is unchanged.

Code: `lib/fee-waiver.ts` (pure calculation), `services/class-fee-waiver-service.ts`
(database, recalculation, rules), `services/class-student-fee-service.ts`
(integration).

## Hand-written SQL (migration `20261108120000_add_fee_waiver_rules`)

Prisma 5.22 cannot express these; they live only in the migration SQL:

- `ClassFeeWaiverRule_active_sequence_key`: `UNIQUE ("classId", "sequence") WHERE "status" = 0`
  (one active rule per position; removed rules keep their row).
- CHECK constraints on rule `value`, `sequence` (1–20), percentages (≤ 100) and
  the settings month/year.
- The `FeeWaiverSettings` row (see below) and two backfills.

`prisma migrate dev` / `migrate diff` may show the partial index as drift and
generate `DROP INDEX "ClassFeeWaiverRule_active_sequence_key"`. Never commit
such a statement. `tests/fee-waiver/fee-waiver-migration-guard.test.cjs` fails
if the manual SQL is lost or altered.

## Launch gate: `FeeWaiverSettings`

Automatic waivers apply only to billing months on or after
`FeeWaiverSettings.startYear/startMonth` (row id `default`). The migration
writes it as **the first full Asia/Colombo calendar month after the migration
is applied**, i.e. after deployment:

```sql
date_trunc('month', now() AT TIME ZONE 'Asia/Colombo') + interval '1 month'
```

Applied on 15 Nov 2026 → December 2026; applied at 1 Dec 2026 00:30 Colombo →
January 2027. The application validates the row on every run; a missing or
invalid row turns automatic waivers off everywhere (logged as
`[FEE_WAIVER] start month not configured`). Every path — invoice creation, the
page-load pass, Reprocess, amount changes, approval / decline / lecture events
and reset — checks the same gate and never writes waiver columns for earlier
months (reset answers 409 `WAIVER_NOT_ACTIVE_FOR_MONTH`).

Postponing the start month is an operator action that needs explicit approval:

```sql
UPDATE "FeeWaiverSettings" SET "startYear" = <y>, "startMonth" = <m> WHERE "id" = 'default';
```

## Backfills

1. `lateJoinDeductManual = true` where `lateJoinDeduct > 0`: deductions entered
   by teachers before this feature are never overwritten.
2. `approvedAt = confirmedAt` for public registrations that are currently
   APPROVED. **Approximate:** `confirmedAt` holds the latest decision, so a
   decline → re-approval history cannot be recovered and no original approval
   time is invented. All backfilled values predate the launch month, so they
   never decide a waiver.

## Approval timestamps

`Student.approvedAt` (real UTC) is set on the FIRST transition to APPROVED and
never cleared or overwritten (decline and re-approval leave it unchanged). Only
the student's original public-registration enrolment counts from
`max(assignedAt, approvedAt)`; every other enrolment counts from its own
`assignedAt`.
