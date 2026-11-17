import type { Metadata } from "next";

import PricingPage, { PricingContent } from "@/components/pricing/PricingPage";
import { loadPricingState } from "@/services/public-pricing-service";

// Public (not under any middleware-protected prefix). Rendered per request so
// plan changes made by an administrator show at once (and the build needs no database).
export const dynamic = "force-dynamic";

const DESCRIPTION =
  "SL Classroom plans for teachers: prices, billing intervals and live classroom capacity for each plan, with custom pricing for institutions.";

export const metadata: Metadata = {
  title: "Pricing",
  description: DESCRIPTION,
  alternates: { canonical: "/pricing" },
  // A page's openGraph replaces the root layout's, so siteName and locale are repeated here.
  openGraph: {
    title: "SL Classroom Pricing",
    description: DESCRIPTION,
    url: "/pricing",
    type: "website",
    siteName: "SL Classroom",
    locale: "en_LK",
  },
};

export default async function PricingRoute() {
  const state = await loadPricingState();
  return (
    <PricingPage>
      <PricingContent state={state} />
    </PricingPage>
  );
}
