import type { Metadata } from "next";

import LegalPage from "@/components/legal/LegalPage";
import { termsIntro, termsSections } from "@/components/legal/terms-content";
import { legalPageMetadata } from "@/lib/legal/metadata";

// Public (not under any middleware-protected prefix). Static: no request data.
export const metadata: Metadata = legalPageMetadata({
  path: "/terms",
  title: "Terms & Conditions",
  description:
    "The terms for using SL Classroom: the platform's role, teacher and student responsibilities, accounts, live classes and recordings, content, fees and acceptable use.",
});

export default function TermsPage() {
  return <LegalPage pageKey="terms" title="Terms & Conditions" intro={termsIntro} sections={termsSections} />;
}
