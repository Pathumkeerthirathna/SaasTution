import type { Prisma, PrismaClient } from "@prisma/client";
import type { z } from "zod";

import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import {
  createPaymentAccountSchema,
  MAX_PAYMENT_ACCOUNTS_PER_TEACHER,
  updatePaymentAccountSchema,
  type CreatePaymentAccountInput,
  type PaymentAccountType,
  type UpdatePaymentAccountInput,
} from "@/lib/teacher-payment-account-validation";

/*
 * Teacher payment accounts ("Payment Details" on the teacher profile).
 *
 * Display information only: the bank accounts a teacher publishes so students
 * and parents know where to pay. Nothing here touches ClassPayment, receipts,
 * payment confirmations or gateways.
 *
 * Authorization:
 *   - Every OWNER function takes the signed-in teacher's id (from the server
 *     session, never from the request) and scopes every query by it: another
 *     teacher's account - or a removed one - is "not found" (404), so an id
 *     from someone else can be neither read nor changed (no IDOR).
 *   - getPublishedPaymentAccounts is the ONLY read for visitors and students:
 *     active, public, non-removed accounts of a teacher whose Payment Details
 *     switch is on, with display fields only (no ids, teacher id, flags or
 *     timestamps).
 *
 * Primary account: exactly one while any account exists. Every change that
 * can move it (create, set primary, delete) runs in ONE interactive
 * transaction holding a per-teacher advisory lock, so two requests cannot
 * race; the partial unique index "TeacherPaymentAccount_one_primary_per_teacher"
 * is the database backstop (at most one).
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** What the owner sees and manages. */
export type OwnerPaymentAccount = {
  id: string;
  label: string | null;
  accountHolderName: string;
  bankName: string;
  branchName: string | null;
  accountNumber: string;
  accountType: PaymentAccountType;
  isPrimary: boolean;
  isPublic: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** What visitors and students see: display fields only. */
export type PublishedPaymentAccount = {
  label: string | null;
  accountHolderName: string;
  bankName: string;
  branchName: string | null;
  accountNumber: string;
  accountType: PaymentAccountType;
  isPrimary: boolean;
};

const OWNER_SELECT = {
  id: true,
  label: true,
  accountHolderName: true,
  bankName: true,
  branchName: true,
  accountNumber: true,
  accountType: true,
  isPrimary: true,
  isPublic: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TeacherPaymentAccountSelect;

const PUBLISHED_SELECT = {
  label: true,
  accountHolderName: true,
  bankName: true,
  branchName: true,
  accountNumber: true,
  accountType: true,
  isPrimary: true,
} satisfies Prisma.TeacherPaymentAccountSelect;

/** Primary first, then oldest first (a stable order for every list). */
const ACCOUNT_ORDER: Prisma.TeacherPaymentAccountOrderByWithRelationInput[] = [{ isPrimary: "desc" }, { createdAt: "asc" }, { id: "asc" }];

/** The advisory-lock key of one teacher's payment accounts (its own namespace). */
export function teacherPaymentAccountLockKey(teacherId: string): string {
  return `teacher-payment-accounts:teacher:${teacherId}`;
}

async function lockTeacherPaymentAccounts(tx: Prisma.TransactionClient, teacherId: string): Promise<void> {
  // $executeRaw: pg_advisory_xact_lock returns void, which $queryRaw cannot read (it throws).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${teacherPaymentAccountLockKey(teacherId)}, 0))`;
}

function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError(issue?.message || "Invalid payment account details.", 400, "VALIDATION_ERROR");
  }
  return parsed.data;
}

function notFound(): AppError {
  return new AppError("Payment account not found.", 404, "PAYMENT_ACCOUNT_NOT_FOUND");
}

function requireTeacherId(teacherId: string): string {
  if (typeof teacherId !== "string" || teacherId.trim() === "") {
    throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
  }
  return teacherId;
}

/** The teacher's own account, or 404 (another teacher's, removed, or unknown). */
async function findOwnAccount(db: Db, teacherId: string, accountId: string) {
  if (typeof accountId !== "string" || accountId.trim() === "" || accountId.length > 64) throw notFound();
  const account = await db.teacherPaymentAccount.findFirst({
    where: { id: accountId, teacherId, status: 0 },
    select: { id: true, isPrimary: true },
  });
  if (!account) throw notFound();
  return account;
}

/** Makes `accountId` the only primary account of the teacher (inside the caller's locked transaction). */
async function makePrimary(tx: Prisma.TransactionClient, teacherId: string, accountId: string): Promise<void> {
  await tx.teacherPaymentAccount.updateMany({
    where: { teacherId, status: 0, isPrimary: true, NOT: { id: accountId } },
    data: { isPrimary: false },
  });
  await tx.teacherPaymentAccount.updateMany({ where: { id: accountId, teacherId, status: 0 }, data: { isPrimary: true } });
}

/** When no primary is left: the oldest remaining account (active ones first) becomes primary. */
async function ensurePrimary(tx: Prisma.TransactionClient, teacherId: string): Promise<void> {
  const primary = await tx.teacherPaymentAccount.findFirst({ where: { teacherId, status: 0, isPrimary: true }, select: { id: true } });
  if (primary) return;
  const next = await tx.teacherPaymentAccount.findFirst({
    where: { teacherId, status: 0 },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (next) await tx.teacherPaymentAccount.updateMany({ where: { id: next.id, teacherId, status: 0 }, data: { isPrimary: true } });
}

// ---- Owner -------------------------------------------------------------------------------------------------

export async function listOwnerPaymentAccounts(teacherId: string): Promise<OwnerPaymentAccount[]> {
  requireTeacherId(teacherId);
  return prisma.teacherPaymentAccount.findMany({ where: { teacherId, status: 0 }, orderBy: ACCOUNT_ORDER, select: OWNER_SELECT });
}

/** Adds an account. The first account is always primary; isPrimary on a later one moves the primary to it. */
export async function createPaymentAccount(teacherId: string, input: unknown): Promise<OwnerPaymentAccount> {
  requireTeacherId(teacherId);
  const data: CreatePaymentAccountInput = parseInput(createPaymentAccountSchema, input);
  return prisma.$transaction(async (tx) => {
    await lockTeacherPaymentAccounts(tx, teacherId);
    const existing = await tx.teacherPaymentAccount.count({ where: { teacherId, status: 0 } });
    if (existing >= MAX_PAYMENT_ACCOUNTS_PER_TEACHER) {
      throw new AppError(`You can add at most ${MAX_PAYMENT_ACCOUNTS_PER_TEACHER} payment accounts.`, 409, "PAYMENT_ACCOUNT_LIMIT");
    }
    const created = await tx.teacherPaymentAccount.create({
      data: {
        teacherId,
        label: data.label ?? null,
        accountHolderName: data.accountHolderName,
        bankName: data.bankName,
        branchName: data.branchName ?? null,
        accountNumber: data.accountNumber,
        accountType: data.accountType,
        isPublic: data.isPublic,
        isActive: data.isActive,
        isPrimary: false,
      },
      select: { id: true },
    });
    if (existing === 0 || data.isPrimary) await makePrimary(tx, teacherId, created.id);
    return tx.teacherPaymentAccount.findFirstOrThrow({ where: { id: created.id, teacherId }, select: OWNER_SELECT });
  });
}

/**
 * Updates the teacher's own account. isPrimary: true makes it the primary;
 * isPrimary: false on the current primary is refused (choose another primary
 * instead), so exactly one primary always remains.
 */
export async function updatePaymentAccount(teacherId: string, accountId: string, input: unknown): Promise<OwnerPaymentAccount> {
  requireTeacherId(teacherId);
  const data: UpdatePaymentAccountInput = parseInput(updatePaymentAccountSchema, input);
  return prisma.$transaction(async (tx) => {
    await lockTeacherPaymentAccounts(tx, teacherId);
    const account = await findOwnAccount(tx, teacherId, accountId);
    if (data.isPrimary === false && account.isPrimary) {
      throw new AppError("Choose another account as the primary account instead.", 409, "PRIMARY_ACCOUNT_REQUIRED");
    }
    const { isPrimary, ...fields } = data;
    const update = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    if (Object.keys(update).length > 0) {
      await tx.teacherPaymentAccount.updateMany({ where: { id: account.id, teacherId, status: 0 }, data: update });
    }
    if (isPrimary === true && !account.isPrimary) await makePrimary(tx, teacherId, account.id);
    return tx.teacherPaymentAccount.findFirstOrThrow({ where: { id: account.id, teacherId }, select: OWNER_SELECT });
  });
}

export async function setPrimaryPaymentAccount(teacherId: string, accountId: string): Promise<OwnerPaymentAccount> {
  requireTeacherId(teacherId);
  return prisma.$transaction(async (tx) => {
    await lockTeacherPaymentAccounts(tx, teacherId);
    const account = await findOwnAccount(tx, teacherId, accountId);
    if (!account.isPrimary) await makePrimary(tx, teacherId, account.id);
    return tx.teacherPaymentAccount.findFirstOrThrow({ where: { id: account.id, teacherId }, select: OWNER_SELECT });
  });
}

/** Removes the teacher's own account (soft delete). If it was the primary, the oldest remaining account takes over. */
export async function deletePaymentAccount(teacherId: string, accountId: string): Promise<{ id: string }> {
  requireTeacherId(teacherId);
  return prisma.$transaction(async (tx) => {
    await lockTeacherPaymentAccounts(tx, teacherId);
    const account = await findOwnAccount(tx, teacherId, accountId);
    await tx.teacherPaymentAccount.updateMany({ where: { id: account.id, teacherId, status: 0 }, data: { status: 1, isPrimary: false } });
    if (account.isPrimary) await ensurePrimary(tx, teacherId);
    return { id: account.id };
  });
}

// ---- Visitors and students (read-only) ----------------------------------------------------------------------

/**
 * The accounts a teacher has PUBLISHED: [] when the profile's Payment Details
 * switch is off; otherwise the active, public, non-removed accounts, primary
 * first, with display fields only.
 */
export async function getPublishedPaymentAccounts(teacherId: string): Promise<PublishedPaymentAccount[]> {
  if (typeof teacherId !== "string" || teacherId.trim() === "") return [];
  const profile = await prisma.teacherProfile.findUnique({ where: { teacherId }, select: { isDisplayPaymentDetails: true } });
  if (!profile || !profile.isDisplayPaymentDetails) return [];
  return prisma.teacherPaymentAccount.findMany({
    where: { teacherId, status: 0, isActive: true, isPublic: true },
    orderBy: ACCOUNT_ORDER,
    select: PUBLISHED_SELECT,
  });
}
