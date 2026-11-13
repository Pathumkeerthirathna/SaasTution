import type { Metadata } from "next";
import type { ReactNode } from "react";

/*
 * /reset-password and /reset-password/confirm only (Student Profile SP-7E):
 *  - no referrer: <meta name="referrer" content="no-referrer"> here, plus the
 *    Referrer-Policy: no-referrer response header for these two paths only
 *    (next.config.mjs), so a reset address never leaves in a Referer header;
 *  - not cached: rendered per request (force-dynamic), for which Next.js
 *    sends Cache-Control: private, no-cache, no-store, max-age=0,
 *    must-revalidate;
 *  - not indexed.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function ResetPasswordLayout({ children }: { children: ReactNode }) {
  return children;
}
