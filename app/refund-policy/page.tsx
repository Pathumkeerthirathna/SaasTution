import type { Metadata } from "next";

import LegalPage from "@/components/legal/LegalPage";
import { refundIntro, refundSections } from "@/components/legal/refund-content";
import { legalPageMetadata } from "@/lib/legal/metadata";

// Public (not under any middleware-protected prefix). Static: no request data.
export const metadata: Metadata = legalPageMetadata({
  path: "/refund-policy",
  title: "Refund & Cancellation Policy",
  description:
    "How class cancellations, missed classes and tuition refund requests are handled between independent teachers and students on SL Classroom.",
});

export default function RefundPolicyPage() {
  return (
    <LegalPage
      pageKey="refund-policy"
      title="Refund & Cancellation Policy"
      intro={refundIntro}
      sections={refundSections}
    />
  );
}
