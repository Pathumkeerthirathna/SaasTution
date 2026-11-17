import PricingPage, { PricingLoadingView } from "@/components/pricing/PricingPage";

// Shown while the plans are read from the database.
export default function PricingLoading() {
  return (
    <PricingPage>
      <PricingLoadingView />
    </PricingPage>
  );
}
