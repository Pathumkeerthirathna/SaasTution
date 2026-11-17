/*
 * Settings and open decisions shared by the public legal pages:
 * /terms, /privacy and /refund-policy (app/terms, app/privacy, app/refund-policy).
 *
 * DRAFT STATUS. These pages are first business drafts written from what the
 * application actually does (see the notes in each content file). They have
 * NOT been reviewed by a lawyer. While LEGAL_DOCUMENT_STATUS.isDraft is true:
 *   - every page shows a "Draft" notice,
 *   - the pages are served with noindex (search engines do not list them),
 *   - "Effective date" reads "Not yet in effect".
 *
 * Before publishing: resolve every item in LEGAL_OPEN_DECISIONS, fill in the
 * matching value below (null = not decided yet), have the text reviewed, then
 * set isDraft to false and the effective date.
 *
 * Unknown values are null, never invented. Where a value is null, the pages
 * use neutral wording (e.g. "the notice period your teacher sets") instead of
 * showing a placeholder to visitors.
 */

export const LEGAL_PLATFORM = {
  /** As shown across the public site (navbar, footer, metadata). */
  name: "SL Classroom",
  website: "https://slclassroom.live",
  contactEmail: "pathumkumara808@gmail.com",
} as const;

export const LEGAL_DOCUMENT_STATUS = {
  isDraft: true,
  /** ISO date (YYYY-MM-DD); null until the owner sets one at publication. */
  effectiveDate: null as string | null,
  /** ISO date (YYYY-MM-DD) of the last content change. */
  lastUpdated: "2026-11-17",
} as const;

/**
 * Who operates SL Classroom and how to reach them. null = not decided.
 *
 * SL Classroom is currently operated by an individual, not a registered
 * company: never describe the operator as a company or registered business.
 * If a business is registered later, update operatorName and this note.
 */
export const LEGAL_BUSINESS_DETAILS = {
  /** The individual (or, later, registered business) that operates SL Classroom. */
  operatorName: "A.E.G.N. Pathum Kumara" as string | null,
  /** Contact telephone number, shown in each page's contact block. */
  telephone: "0711455219" as string | null,
  /** Postal address of the operator. */
  businessAddress: "Track 06, No. 28, Upper Division, Bakamuna, Sri Lanka" as string | null,
  /**
   * Governing law and courts. When set, the Terms include the "Governing Law
   * and Jurisdiction" section (components/legal/terms-content.tsx), whose
   * wording must match this value.
   */
  governingLaw: "Laws of Sri Lanka" as string | null,
} as const;

/** Cancellation and refund rules still to be decided. null = not decided. */
export const LEGAL_REFUND_RULES = {
  /** How far ahead a student must cancel, e.g. "24 hours before the class". */
  studentCancellationNotice: null as string | null,
  /** How far ahead a teacher must notify students of a cancellation. */
  teacherCancellationNotice: null as string | null,
  /** How long after a payment or class a refund request can be made. */
  refundRequestWindow: null as string | null,
} as const;

export type LegalPageKey = "terms" | "privacy" | "refund-policy";

export type LegalOpenDecision = {
  id: string;
  topic: string;
  /** What has to be decided or confirmed, and by whom. */
  question: string;
  pages: LegalPageKey[];
  /** true once the owner has decided and the text (or a value above) matches. */
  decided?: boolean;
};

/**
 * Review checklist: every legal or business decision behind these pages, in
 * one place. Items without `decided: true` are still open. Mark an item
 * decided once it is resolved and the text (or a value above) has been
 * updated to match.
 */
export const LEGAL_OPEN_DECISIONS: LegalOpenDecision[] = [
  {
    id: "operator-identity",
    topic: "Operator",
    question:
      "Operator, telephone and postal address confirmed (LEGAL_BUSINESS_DETAILS): SL Classroom is operated by an individual, A.E.G.N. Pathum Kumara. If a business name is registered (for example for the PayHere merchant account), update operatorName and the wording so the pages match the registration.",
    pages: ["terms", "privacy", "refund-policy"],
  },
  {
    id: "governing-law",
    topic: "Governing law",
    question:
      "Decided: the Terms are governed by the laws of Sri Lanka, and disputes are subject to the jurisdiction of the competent courts of Sri Lanka (LEGAL_BUSINESS_DETAILS.governingLaw; Terms section \"Governing Law and Jurisdiction\"). The overall legal review (legal-review) still applies to this wording.",
    pages: ["terms"],
    decided: true,
  },
  {
    id: "legal-review",
    topic: "Legal review",
    question:
      "Have all three pages reviewed by a qualified lawyer, including the limitation of liability wording and which data-protection law applies (for example Sri Lanka's Personal Data Protection Act).",
    pages: ["terms", "privacy", "refund-policy"],
  },
  {
    id: "payment-architecture",
    topic: "Online payments",
    question:
      "Decide the payment settlement model. Today the platform records fees and payment slips only; no online gateway is integrated. If PayHere (or another provider) goes live: who is the merchant, who receives and settles funds, who can issue refunds, and which fees apply. Then update the payment sections of all three pages.",
    pages: ["terms", "privacy", "refund-policy"],
  },
  {
    id: "platform-charges",
    topic: "Platform charges",
    question:
      "Decided: teacher subscriptions are charged in advance; teachers can cancel automatic renewal at any time and keep access until the end of the paid period; no partial refunds for unused periods; duplicate payments and confirmed billing errors are refunded; other requests are reviewed individually, subject to applicable law (Terms \"Teacher Subscriptions and Billing\", Refund policy \"Teacher Subscription Refunds\"). Prices, billing periods and the payment method stay in each plan; update the pages if subscriptions are paid through an online provider (payment-architecture).",
    pages: ["terms", "refund-policy"],
    decided: true,
  },
  {
    id: "per-class-fees",
    topic: "Per-class fees",
    question:
      "The platform currently records fees per month. Confirm whether per-class fees will be recorded in the platform or stay an arrangement between teacher and student.",
    pages: ["terms", "refund-policy"],
  },
  {
    id: "cancellation-notice",
    topic: "Cancellation notice",
    question:
      "Decide whether the platform sets minimum notice periods for student and teacher cancellations (LEGAL_REFUND_RULES.studentCancellationNotice / teacherCancellationNotice) or leaves them to each teacher.",
    pages: ["refund-policy"],
  },
  {
    id: "refund-window",
    topic: "Refund request window",
    question:
      "Decide the time limit for refund requests (LEGAL_REFUND_RULES.refundRequestWindow), whether any refunds are automatic, and how partial-month refunds are calculated, if at all.",
    pages: ["refund-policy"],
  },
  {
    id: "teacher-refund-expectations",
    topic: "Teacher obligations",
    question:
      "Confirm the expectations the Refund & Cancellation Policy places on teachers: offering a replacement, refund or credit for classes they cancel or miss, refunding duplicate payments and overpayments, and fees staying payable when a student misses a class that was held.",
    pages: ["refund-policy"],
  },
  {
    id: "support-workflow",
    topic: "Support workflow",
    question:
      "Refund requests, disputes and privacy requests currently go to the contact email. Decide response times and whether a dedicated support form or ticket system is needed.",
    pages: ["privacy", "refund-policy"],
  },
  {
    id: "minimum-age",
    topic: "Children and guardians",
    question:
      "Decide whether there is a minimum age, whether parent or guardian consent is required for minors, and how it would be recorded. Registration currently asks for no age or date of birth.",
    pages: ["terms", "privacy"],
  },
  {
    id: "retention-periods",
    topic: "Data retention",
    question:
      "Set retention periods for deactivated accounts, attendance, fee and payment records, uploaded files, login and device history, error logs and recordings. Most records are deactivated (soft-deleted), not erased, today.",
    pages: ["privacy"],
  },
  {
    id: "service-providers",
    topic: "Service providers",
    question:
      "Decide whether to name the hosting provider and the email (SMTP) provider in the Privacy Policy, and confirm where (which country) data is stored.",
    pages: ["privacy"],
  },
  {
    id: "whiteboard-fonts",
    topic: "Whiteboard fonts",
    question:
      "The Excalidraw whiteboard may fetch its fonts from esm.sh (a public CDN). Decide whether to self-host them (then remove that item from the Privacy Policy's Third-Party Services).",
    pages: ["privacy"],
  },
  {
    id: "teacher-verification",
    topic: "Teacher approval",
    question:
      "Teacher accounts are approved by an administrator. Confirm what that approval checks, if anything, so the pages never imply a qualification or background check that does not happen.",
    pages: ["terms"],
  },
  {
    id: "content-licence",
    topic: "Content licence",
    question:
      "Confirm the licence wording for teacher and student content (the Terms grant the platform only the rights needed to run the service) and whether teachers may reuse student submissions.",
    pages: ["terms"],
  },
  {
    id: "recording-consent",
    topic: "Recording notice",
    question:
      "Decide how participants are told a session is being recorded or broadcast to YouTube, and whether students may opt out of being recorded.",
    pages: ["terms", "privacy"],
  },
];

/** "17 November 2026" for an ISO date (YYYY-MM-DD); the input itself if it is not one. */
export function formatLegalDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const month = months[Number(match[2]) - 1];
  if (!month) return isoDate;
  return `${Number(match[3])} ${month} ${match[1]}`;
}
