/*
 * Recorded Lectures (RL-3.1): safe conversion between the database's BIGINT
 * columns (Prisma: JavaScript `bigint`) and the plain numbers the RL-1 code
 * and the API use. Pure: no I/O.
 *
 * Rules:
 *   - bigint -> number only when the value is inside the safe-integer range
 *     (checked on the bigint BEFORE converting, then Number.isSafeInteger on
 *     the result), otherwise RecordedLectureIntegerError (fail closed: never
 *     a rounded number);
 *   - number -> bigint only after Number.isSafeInteger(value) holds;
 *   - byte counts and offsets are never negative (the *ByteCount helpers);
 *   - a raw bigint never reaches JSON: API responses are built by
 *     upload-dto.ts from these helpers (JSON.stringify throws on a bigint).
 *
 * The error message never contains the value itself.
 */

/** TypeScript targets ES2017 here, so no bigint literals (`0n`): BigInt(...) instead. */
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const ZERO = BigInt(0);

export type IntegerConversionProblem = "NOT_A_BIGINT" | "NOT_A_SAFE_INTEGER" | "NEGATIVE" | "OUT_OF_SAFE_RANGE";

/** An integer could not be converted safely (a programming or data error: 500, never shown in detail). */
export class RecordedLectureIntegerError extends Error {
  readonly problem: IntegerConversionProblem;
  readonly field: string;

  constructor(problem: IntegerConversionProblem, field: string) {
    super(`Unsafe integer conversion (${field}: ${problem}).`);
    this.name = "RecordedLectureIntegerError";
    this.problem = problem;
    this.field = field;
  }
}

export function isRecordedLectureIntegerError(error: unknown): error is RecordedLectureIntegerError {
  return error instanceof Error && error.name === "RecordedLectureIntegerError";
}

/** A database bigint as a number; throws unless it is a safe integer. */
export function bigintToSafeNumber(value: unknown, field = "value"): number {
  if (typeof value !== "bigint") throw new RecordedLectureIntegerError("NOT_A_BIGINT", field);
  if (value > MAX_SAFE_BIGINT || value < MIN_SAFE_BIGINT) throw new RecordedLectureIntegerError("OUT_OF_SAFE_RANGE", field);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RecordedLectureIntegerError("OUT_OF_SAFE_RANGE", field);
  return number;
}

/** A number as a database bigint; throws unless it is a safe integer (checked before converting). */
export function safeNumberToBigint(value: unknown, field = "value"): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RecordedLectureIntegerError("NOT_A_SAFE_INTEGER", field);
  }
  return BigInt(value);
}

/** A database byte count / offset (bigint, >= 0) as a number. */
export function byteCountToNumber(value: unknown, field = "byteCount"): number {
  if (typeof value === "bigint" && value < ZERO) throw new RecordedLectureIntegerError("NEGATIVE", field);
  return bigintToSafeNumber(value, field);
}

/** A byte count / offset (number, safe integer, >= 0) as a database bigint. */
export function byteCountToBigint(value: unknown, field = "byteCount"): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value < 0) {
    throw new RecordedLectureIntegerError("NEGATIVE", field);
  }
  return safeNumberToBigint(value, field);
}
