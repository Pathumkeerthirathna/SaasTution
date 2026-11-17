import Link from "next/link";
import { AlertTriangle, ArrowRight, Building2, CheckCircle2, Mail, Phone } from "lucide-react";

import { Container } from "@/components/LandingPage/ui";
import Footer from "@/components/Layout/footer";
import Navbar from "@/components/Layout/navbar";
import { LEGAL_BUSINESS_DETAILS, LEGAL_PLATFORM } from "@/lib/legal/config";
import type { PricingState, PublicPlan } from "@/services/public-pricing-service";

/*
 * The public pricing page (/pricing). Everything about a plan (name, price,
 * interval, live participants, features) comes from the ACTIVE
 * SubscriptionPlan rows (services/public-pricing-service.ts); nothing is
 * hard-coded here. Teachers register at /register and choose their plan from
 * the dashboard while their account awaits approval (the existing flow);
 * institutions are offered a contact option instead. No online payment exists:
 * the page says so and does not imply otherwise.
 *
 * Server component; the views are exported for tests (react-dom/server).
 */

const REGISTER_HREF = "/register";
const INSTITUTION_SUBJECT = "Institution plan enquiry";

// ---- Pure helpers ------------------------------------------------------------------------------------------

/** A plan for institutions (by name), which gets a contact action instead of self-registration. */
export function isInstitutionPlan(plan: Pick<PublicPlan, "name">): boolean {
  return /\binstitution/i.test(plan.name);
}

const integer = (value: number) => new Intl.NumberFormat("en-US").format(value);

export function intervalSuffix(interval: string): string {
  return interval === "MONTHLY" ? "per month" : interval === "YEARLY" ? "per year" : interval.toLowerCase();
}

export function billingLabel(interval: string): string {
  return interval === "MONTHLY" ? "Billed monthly" : interval === "YEARLY" ? "Billed yearly" : `Billed ${interval.toLowerCase()}`;
}

/** The displayed price: the plan's currency and amount (or "Free" for a zero price). */
export function formatPlanAmount(plan: Pick<PublicPlan, "price" | "currency">): string {
  if (plan.price === 0) return "Free";
  return `${plan.currency} ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(plan.price)}`;
}

/** The features a plan's own database fields describe, nothing else. */
export function planFeatures(plan: PublicPlan): string[] {
  const features = [`Up to ${integer(plan.maxLiveParticipants)} live classroom participants`];
  if (plan.unlimitedStudents) features.push("Unlimited LMS student registrations");
  if (plan.unlimitedLiveSessions) features.push("Unlimited live classes");
  if (plan.unlimitedRecording) features.push("Unlimited recording sessions");
  features.push(plan.storageGB === null ? "Unlimited file storage" : `${integer(plan.storageGB)} GB file storage`);
  return features;
}

/** "monthly", "yearly" or "monthly or yearly", from the intervals the plans actually use. */
export function billingIntervalsText(plans: PublicPlan[]): string {
  const intervals = new Set(plans.map((plan) => plan.interval));
  const names = [intervals.has("MONTHLY") && "monthly", intervals.has("YEARLY") && "yearly"].filter(Boolean) as string[];
  return names.length ? names.join(" or ") : "monthly or yearly";
}

export function institutionMailto(): string {
  return `mailto:${LEGAL_PLATFORM.contactEmail}?subject=${encodeURIComponent(INSTITUTION_SUBJECT)}`;
}

// ---- Views --------------------------------------------------------------------------------------------------

const primaryButton =
  "mt-6 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-[14px] font-semibold text-white shadow-sm transition hover:bg-emerald-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600";
const secondaryButton =
  "mt-6 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-[#112D5C] px-4 py-3 text-[14px] font-semibold text-[#112D5C] transition hover:bg-[#112D5C] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#112D5C]";

function FeatureList({ items }: { items: string[] }) {
  return (
    <ul className="mt-5 space-y-2.5 text-[14px] text-slate-700">
      {items.map((item) => (
        <li key={item} className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function PlanCard({ plan }: { plan: PublicPlan }) {
  const institution = isInstitutionPlan(plan);
  const headingId = `plan-${plan.id}`;
  return (
    <article aria-labelledby={headingId} className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h3 id={headingId} className="text-[18px] font-bold text-slate-900">
        {plan.name}
      </h3>
      {plan.description ? <p className="mt-1.5 text-[13.5px] leading-6 text-slate-600">{plan.description}</p> : null}
      <p className="mt-5">
        <span className="text-[30px] font-bold tracking-tight text-[#112D5C]">{formatPlanAmount(plan)}</span>
        {plan.price !== 0 ? <span className="ml-1.5 text-[14px] font-medium text-slate-500">{intervalSuffix(plan.interval)}</span> : null}
      </p>
      <p className="mt-1 text-[12.5px] text-slate-500">{billingLabel(plan.interval)}</p>
      <div className="flex-1">
        <FeatureList items={planFeatures(plan)} />
      </div>
      {institution ? (
        <a href={institutionMailto()} className={secondaryButton} aria-label={`Contact us about the ${plan.name} plan`}>
          <Mail className="h-4 w-4" aria-hidden="true" />
          Contact us
        </a>
      ) : (
        <Link href={REGISTER_HREF} className={primaryButton} aria-label={`Get started with the ${plan.name} plan`}>
          Get started
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      )}
    </article>
  );
}

export function InstitutionContactCard() {
  return (
    <article aria-labelledby="plan-institution" className="flex h-full flex-col rounded-2xl border border-[#112D5C]/20 bg-[#112D5C]/[0.03] p-6 shadow-sm">
      <h3 id="plan-institution" className="flex items-center gap-2 text-[18px] font-bold text-slate-900">
        <Building2 className="h-5 w-5 text-[#112D5C]" aria-hidden="true" />
        Institution
      </h3>
      <p className="mt-5 text-[26px] font-bold tracking-tight text-[#112D5C]">Custom pricing</p>
      <p className="mt-3 flex-1 text-[14px] leading-6 text-slate-700">
        For institutions that need larger live classes. Live classroom capacity and pricing are agreed individually,
        based on your requirements and available capacity.
      </p>
      <a href={institutionMailto()} className={secondaryButton} aria-label="Contact us about institution pricing">
        <Mail className="h-4 w-4" aria-hidden="true" />
        Contact us
      </a>
      {LEGAL_BUSINESS_DETAILS.telephone ? (
        <p className="mt-3 flex items-center justify-center gap-1.5 text-[13px] text-slate-600">
          <Phone className="h-3.5 w-3.5" aria-hidden="true" />
          <a href={`tel:${LEGAL_BUSINESS_DETAILS.telephone.replace(/[^\d+]/g, "")}`} className="font-medium text-[#112D5C] hover:underline">
            {LEGAL_BUSINESS_DETAILS.telephone}
          </a>
        </p>
      ) : null}
    </article>
  );
}

export function PricingErrorView() {
  return (
    <div role="alert" className="mx-auto max-w-2xl rounded-2xl border border-red-200 bg-red-50 px-5 py-6 text-center">
      <AlertTriangle className="mx-auto h-6 w-6 text-red-600" aria-hidden="true" />
      <p className="mt-2 text-[15px] font-semibold text-red-800">We couldn&rsquo;t load our plans right now.</p>
      <p className="mt-1 text-[14px] text-red-700">
        Please{" "}
        <Link href="/pricing" className="font-semibold underline underline-offset-2">
          try again
        </Link>{" "}
        in a moment, or contact us at{" "}
        <a href={`mailto:${LEGAL_PLATFORM.contactEmail}`} className="font-semibold underline underline-offset-2">
          {LEGAL_PLATFORM.contactEmail}
        </a>
        .
      </p>
    </div>
  );
}

export function PricingEmptyView() {
  return (
    <div role="status" className="mx-auto max-w-2xl rounded-2xl border border-slate-200 bg-slate-50 px-5 py-6 text-center">
      <p className="text-[15px] font-semibold text-slate-800">Our plans are being updated.</p>
      <p className="mt-1 text-[14px] text-slate-600">
        Please contact us at{" "}
        <a href={`mailto:${LEGAL_PLATFORM.contactEmail}`} className="font-semibold text-[#112D5C] underline underline-offset-2">
          {LEGAL_PLATFORM.contactEmail}
        </a>{" "}
        for current pricing.
      </p>
    </div>
  );
}

export function PlanGrid({ plans }: { plans: PublicPlan[] }) {
  const showInstitutionContact = !plans.some(isInstitutionPlan);
  const cards = plans.length + (showInstitutionContact ? 1 : 0);
  const columns = cards === 1 ? "mx-auto max-w-sm" : cards >= 4 ? "sm:grid-cols-2 xl:grid-cols-4" : "sm:grid-cols-2 lg:grid-cols-3";
  return (
    <>
      {plans.length === 0 ? <PricingEmptyView /> : null}
      <div className={`mt-8 grid grid-cols-1 gap-6 ${columns}`}>
        {plans.map((plan) => (
          <PlanCard key={plan.id} plan={plan} />
        ))}
        {showInstitutionContact ? <InstitutionContactCard /> : null}
      </div>
      {plans.some((plan) => !isInstitutionPlan(plan)) ? (
        <p className="mx-auto mt-6 max-w-3xl text-center text-[13.5px] leading-6 text-slate-600">
          After registering as a teacher, you choose your plan from your dashboard. Your account and plan become active
          once our team has confirmed them.
        </p>
      ) : null}
    </>
  );
}

export function BillingInfo({ plans }: { plans: PublicPlan[] }) {
  return (
    <section aria-labelledby="billing-heading" className="mx-auto mt-14 max-w-3xl rounded-2xl border border-slate-200 bg-slate-50 p-6 sm:p-8">
      <h2 id="billing-heading" className="text-[20px] font-bold tracking-tight text-slate-900">
        How billing works
      </h2>
      <p className="mt-3 text-[14.5px] leading-7 text-slate-700">
        Plans are billed {billingIntervalsText(plans)}, according to the billing interval shown on each plan. Prices
        are shown in the plan&rsquo;s currency. Subscription charges are paid by teachers to {LEGAL_PLATFORM.name} and
        are separate from the tuition fees your students pay you.
      </p>
      <dl className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <dt className="text-[12px] font-semibold uppercase tracking-wider text-emerald-700">Available now</dt>
          <dd className="mt-1.5 text-[14px] leading-6 text-slate-700">
            Register, choose your plan from your dashboard, and our team will contact you to confirm your subscription
            and arrange payment.
          </dd>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <dt className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">Not available yet</dt>
          <dd className="mt-1.5 text-[14px] leading-6 text-slate-700">
            Online card payment through {LEGAL_PLATFORM.name}. Until it is available, no card details are requested
            on this site.
          </dd>
        </div>
      </dl>
      <p className="mt-5 text-[13.5px] leading-6 text-slate-600">
        See our{" "}
        <Link href="/terms" className="font-medium text-[#112D5C] underline underline-offset-2">
          Terms &amp; Conditions
        </Link>{" "}
        and{" "}
        <Link href="/refund-policy" className="font-medium text-[#112D5C] underline underline-offset-2">
          Refund &amp; Cancellation Policy
        </Link>{" "}
        for subscription and refund terms.
      </p>
    </section>
  );
}

function PricingHeader() {
  return (
    <header className="border-b border-slate-200 bg-gradient-to-b from-emerald-50/70 to-white">
      <Container className="py-12 text-center sm:py-16">
        <p className="text-[12.5px] font-semibold uppercase tracking-wider text-emerald-700">Pricing</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Plans for teaching online</h1>
        <p className="mx-auto mt-4 max-w-2xl text-[15.5px] leading-7 text-slate-600">
          Choose the plan that fits your live classes. Every plan below shows its price, billing interval and live
          classroom capacity.
        </p>
      </Container>
    </header>
  );
}

export function PricingContent({ state }: { state: PricingState }) {
  return (
    <Container className="py-12 sm:py-16">
      <h2 className="sr-only">Plans</h2>
      {state.kind === "error" ? (
        <PricingErrorView />
      ) : (
        <>
          <PlanGrid plans={state.plans} />
          <BillingInfo plans={state.plans} />
        </>
      )}
    </Container>
  );
}

export function PricingLoadingView() {
  return (
    <Container className="py-12 sm:py-16">
      <p role="status" className="sr-only">
        Loading plans...
      </p>
      <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <div key={index} className="h-96 animate-pulse rounded-2xl border border-slate-200 bg-slate-100" />
        ))}
      </div>
    </Container>
  );
}

/** The whole page: the site's navbar and footer around the header and the content. */
export default function PricingPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col overflow-x-hidden bg-white text-slate-900">
      <Navbar sectionLinkBase="/" />
      <main className="flex-1">
        <PricingHeader />
        {children}
      </main>
      <Footer />
    </div>
  );
}
