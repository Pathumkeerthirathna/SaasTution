import type { Metadata } from "next";

import LegalPage from "@/components/legal/LegalPage";
import { privacyIntro, privacySections } from "@/components/legal/privacy-content";
import { legalPageMetadata } from "@/lib/legal/metadata";

// Public (not under any middleware-protected prefix). Static: no request data.
export const metadata: Metadata = legalPageMetadata({
  path: "/privacy",
  title: "Privacy Policy",
  description:
    "How SL Classroom collects, uses, shares and protects the personal information of teachers, students and guardians, and the choices you have.",
});

export default function PrivacyPage() {
  return <LegalPage pageKey="privacy" title="Privacy Policy" intro={privacyIntro} sections={privacySections} />;
}
