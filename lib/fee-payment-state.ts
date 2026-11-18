/*
 * The shared payment calculation of one monthly fee (partial payments).
 * Pure (no database), so the fee service, the API routes and the client
 * components all use this one implementation. Re-exported by
 * services/class-student-fee-service.ts.
 *
 * Fee FREEZING is a different rule and stays "any CONFIRMED payment, also a
 * reversed one" (the database conditions in class-student-fee-service.ts).
 */

// One fee's payment position from its payment records.
//
// Rules:
//  - received = CONFIRMED payments that were not reversed (a reversal keeps
//    the original payment and only stops it counting);
//  - PENDING / NEEDS_CLARIFICATION submissions are reported separately and
//    are never received money;
//  - outstanding = max(0, finalAmount - received); an active Free Card means
//    nothing is payable;
//  - the state never treats a first partial payment as settlement.

export type FeePaymentStateName = "FREE_CARD" | "UNPAID" | "PENDING" | "PARTIAL" | "PAID";

export type FeePaymentRecord = {
  amount: number;
  status: "PENDING" | "CONFIRMED" | "NEEDS_CLARIFICATION";
  /** Present when the payment was reversed (ClassPaymentReversal). */
  reversal?: { amount: number } | null;
};

export type FeePaymentState = {
  state: FeePaymentStateName;
  /** Received: CONFIRMED and not reversed. */
  confirmedTotal: number;
  /** Awaiting the teacher (PENDING). Not received. */
  pendingTotal: number;
  /** Awaiting the student (NEEDS_CLARIFICATION). Not received. */
  clarificationTotal: number;
  /** CONFIRMED payments that were reversed (audit only; not received). */
  reversedTotal: number;
  /** Still payable: max(0, finalAmount - confirmedTotal); 0 with a Free Card. */
  outstanding: number;
  /** Received beyond the fee (must never be confirmed; reported, not hidden). */
  overpaidAmount: number;
};

/** The payment columns feePaymentState reads (add to a `payments` select). */
export const PAYMENT_STATE_SELECT = {
  amount: true,
  status: true,
  reversal: { select: { amount: true } },
} as const;

/** Whether a PENDING / NEEDS_CLARIFICATION submission awaits processing. */
export function hasAwaitingSubmission(payments: readonly { status: string }[]): boolean {
  return payments.some((p) => p.status === "PENDING" || p.status === "NEEDS_CLARIFICATION");
}

const toAmount = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

export function feePaymentState(
  fee: { finalAmount: number; freeCard: boolean },
  payments: readonly FeePaymentRecord[]
): FeePaymentState {
  let confirmedTotal = 0;
  let pendingTotal = 0;
  let clarificationTotal = 0;
  let reversedTotal = 0;
  let awaiting = 0;

  for (const payment of payments) {
    const amount = toAmount(payment.amount);
    if (payment.status === "CONFIRMED") {
      if (payment.reversal) reversedTotal += amount;
      else confirmedTotal += amount;
    } else if (payment.status === "PENDING") {
      pendingTotal += amount;
      awaiting += 1;
    } else if (payment.status === "NEEDS_CLARIFICATION") {
      clarificationTotal += amount;
      awaiting += 1;
    }
  }

  const finalAmount = toAmount(fee.finalAmount);
  const outstanding = fee.freeCard ? 0 : Math.max(0, finalAmount - confirmedTotal);
  const overpaidAmount = Math.max(0, confirmedTotal - (fee.freeCard ? 0 : finalAmount));

  // Same precedence as the existing fee sheet: received money first, then a
  // Free Card, then submissions awaiting processing.
  const state: FeePaymentStateName =
    confirmedTotal > 0
      ? outstanding === 0
        ? "PAID"
        : "PARTIAL"
      : fee.freeCard
        ? "FREE_CARD"
        : awaiting > 0
          ? "PENDING"
          : "UNPAID";

  return { state, confirmedTotal, pendingTotal, clarificationTotal, reversedTotal, outstanding, overpaidAmount };
}
