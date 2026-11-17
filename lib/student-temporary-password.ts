import { randomInt } from "node:crypto";

/*
 * Temporary student passwords (simplified registration & first login).
 *
 * Generated on the server with the operating system's CSPRNG
 * (crypto.randomInt: uniform, no modulo bias): 12 characters from a 56-symbol
 * alphabet without look-alikes (no 0/O/o, 1/l/I), always at least one upper-
 * case letter, one lower-case letter and one digit (so it also satisfies the
 * strictest existing password rule, the teacher reset's upper + lower +
 * digit). About 69 bits of entropy. It contains no "-", so it can never equal
 * a registration number (SP-6C).
 *
 * The plain value exists only in memory between generation, hashing and the
 * welcome email; it is never stored, returned by an API or logged.
 */

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const ALPHABET = UPPER + LOWER + DIGITS;

export const TEMPORARY_PASSWORD_LENGTH = 12;

export function generateTemporaryStudentPassword(): string {
  for (;;) {
    let value = "";
    for (let i = 0; i < TEMPORARY_PASSWORD_LENGTH; i += 1) value += ALPHABET[randomInt(ALPHABET.length)];
    if (/[A-Z]/.test(value) && /[a-z]/.test(value) && /[2-9]/.test(value)) return value;
  }
}
