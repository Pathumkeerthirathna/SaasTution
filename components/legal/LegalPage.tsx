import Link from "next/link";
import type { ReactNode } from "react";
import { FileText, Mail } from "lucide-react";

import Footer from "@/components/Layout/footer";
import Navbar from "@/components/Layout/navbar";
import {
  LEGAL_BUSINESS_DETAILS,
  LEGAL_DOCUMENT_STATUS,
  LEGAL_PLATFORM,
  formatLegalDate,
  type LegalPageKey,
} from "@/lib/legal/config";

/*
 * Shared layout of the public legal pages (/terms, /privacy, /refund-policy):
 * the site's navbar and footer, a title block with dates, the draft notice,
 * a table of contents and numbered sections. Server component; the content
 * lives in components/legal/*-content.tsx.
 */

export type LegalSection = {
  /** Anchor id, unique within the page (used by the table of contents). */
  id: string;
  title: string;
  content: ReactNode;
};

export const LEGAL_PAGES: { key: LegalPageKey; href: string; label: string }[] = [
  { key: "terms", href: "/terms", label: "Terms & Conditions" },
  { key: "privacy", href: "/privacy", label: "Privacy Policy" },
  { key: "refund-policy", href: "/refund-policy", label: "Refund & Cancellation Policy" },
];

/* ---------- Content primitives (consistent typography across the pages) ---------- */

export function P({ children }: { children: ReactNode }) {
  return <p className="mt-3 first:mt-0">{children}</p>;
}

export function Sub({ children }: { children: ReactNode }) {
  return <h3 className="mt-6 text-[15.5px] font-semibold text-slate-900 first:mt-0">{children}</h3>;
}

export function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="mt-3 list-disc space-y-1.5 pl-5 marker:text-emerald-600">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50/60 px-4 py-3 text-[14.5px] text-slate-700">
      {children}
    </div>
  );
}

/** Link to another legal page or a public page of the site. */
export function PageLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-800">
      {children}
    </Link>
  );
}

export function ContactEmail() {
  return (
    <a
      href={`mailto:${LEGAL_PLATFORM.contactEmail}`}
      className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-800"
    >
      {LEGAL_PLATFORM.contactEmail}
    </a>
  );
}

/** The contact block closing each page. Operator details appear once confirmed. */
export function ContactDetails({ topic }: { topic: string }) {
  return (
    <>
      <P>
        If you have questions about {topic}, or want to make a request under it, please contact us:
      </P>
      <div className="mt-4 flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 sm:px-5">
        <p className="flex items-center gap-2 text-slate-900">
          <Mail className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
          <span className="font-semibold">Email:</span>
          <span className="min-w-0 break-words">
            <ContactEmail />
          </span>
        </p>
        <p>
          <span className="font-semibold text-slate-900">Website:</span>{" "}
          <span className="break-words">{LEGAL_PLATFORM.website}</span>
        </p>
        {LEGAL_BUSINESS_DETAILS.operatorName ? (
          <p>
            <span className="font-semibold text-slate-900">Operated by:</span> {LEGAL_BUSINESS_DETAILS.operatorName}
          </p>
        ) : null}
        {LEGAL_BUSINESS_DETAILS.telephone ? (
          <p>
            <span className="font-semibold text-slate-900">Telephone:</span>{" "}
            <a
              href={`tel:${LEGAL_BUSINESS_DETAILS.telephone.replace(/[^\d+]/g, "")}`}
              className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-800"
            >
              {LEGAL_BUSINESS_DETAILS.telephone}
            </a>
          </p>
        ) : null}
        {LEGAL_BUSINESS_DETAILS.businessAddress ? (
          <p>
            <span className="font-semibold text-slate-900">Postal address:</span>{" "}
            {LEGAL_BUSINESS_DETAILS.businessAddress}
          </p>
        ) : null}
      </div>
      <P>Please include the email address of your account and enough detail for us to understand your request.</P>
    </>
  );
}

/* ---------- Page layout ---------- */

type LegalPageProps = {
  pageKey: LegalPageKey;
  title: string;
  intro: ReactNode;
  sections: LegalSection[];
};

export default function LegalPage({ pageKey, title, intro, sections }: LegalPageProps) {
  const { isDraft, effectiveDate, lastUpdated } = LEGAL_DOCUMENT_STATUS;
  const related = LEGAL_PAGES.filter((page) => page.key !== pageKey);

  const toc = (
    <ol className="space-y-1 text-[13.5px]">
      {sections.map((section, index) => (
        <li key={section.id}>
          <a
            href={`#${section.id}`}
            className="flex gap-2 rounded-md px-2 py-1.5 text-slate-600 transition hover:bg-slate-100 hover:text-emerald-700"
          >
            <span className="w-5 shrink-0 text-right tabular-nums text-slate-400">{index + 1}.</span>
            <span>{section.title}</span>
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <div className="flex min-h-full flex-col overflow-x-hidden bg-white text-slate-900">
      <Navbar sectionLinkBase="/" />

      <main className="flex-1">
        <header className="border-b border-slate-200 bg-gradient-to-b from-emerald-50/70 to-white">
          <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
            <p className="flex items-center gap-2 text-[12.5px] font-semibold uppercase tracking-wider text-emerald-700">
              <FileText className="h-4 w-4" aria-hidden="true" />
              Legal
            </p>
            <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{title}</h1>
            <div className="mt-4 max-w-3xl text-[15.5px] leading-7 text-slate-600">{intro}</div>
            <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-2 text-[13.5px]">
              <div className="flex gap-1.5">
                <dt className="text-slate-500">Last updated:</dt>
                <dd className="font-semibold text-slate-800">
                  <time dateTime={lastUpdated}>{formatLegalDate(lastUpdated)}</time>
                </dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-slate-500">Effective date:</dt>
                <dd className="font-semibold text-slate-800">
                  {effectiveDate ? (
                    <time dateTime={effectiveDate}>{formatLegalDate(effectiveDate)}</time>
                  ) : (
                    "Not yet in effect"
                  )}
                </dd>
              </div>
            </dl>
            {/* {isDraft ? (
              <div
                role="note"
                className="mt-6 max-w-3xl rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[14px] leading-6 text-amber-900"
              >
                <span className="font-semibold">Draft under review.</span> This document is a working draft. It has
                not yet been finalised or legally reviewed and is not yet in effect. Some details are still being
                confirmed and may change before publication.
              </div>
            ) : null} */}
          </div>
        </header>

        <div className="mx-auto grid w-full max-w-7xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-12 lg:px-8 lg:py-14">
          {/* Table of contents: collapsible on small screens, sticky beside the text on large ones. */}
          <aside>
            <details className="group rounded-xl border border-slate-200 bg-slate-50 lg:hidden">
              <summary className="cursor-pointer list-none px-4 py-3 text-[14px] font-semibold text-slate-800 marker:hidden">
                <span className="flex items-center justify-between">
                  On this page
                  <span className="text-slate-400 transition group-open:rotate-180" aria-hidden="true">
                    ▾
                  </span>
                </span>
              </summary>
              <nav aria-label="Table of contents" className="border-t border-slate-200 px-2 py-3">
                {toc}
              </nav>
            </details>
            <nav aria-label="Table of contents" className="sticky top-24 hidden lg:block">
              <p className="px-2 text-[12px] font-semibold uppercase tracking-wider text-slate-500">On this page</p>
              <div className="mt-3 max-h-[calc(100dvh-8rem)] overflow-y-auto pr-1">{toc}</div>
            </nav>
          </aside>

          <article className="min-w-0 max-w-3xl text-[15px] leading-7 text-slate-700">
            {sections.map((section, index) => (
              <section
                key={section.id}
                id={section.id}
                aria-labelledby={`${section.id}-heading`}
                className="scroll-mt-24 border-b border-slate-100 py-8 first:pt-0 last:border-b-0"
              >
                <h2 id={`${section.id}-heading`} className="text-xl font-bold tracking-tight text-slate-900 sm:text-[22px]">
                  <span className="mr-2 text-emerald-600">{index + 1}.</span>
                  {section.title}
                </h2>
                <div className="mt-4 break-words">{section.content}</div>
              </section>
            ))}

            <nav aria-label="Related policies" className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 sm:px-5">
              <p className="text-[13px] font-semibold uppercase tracking-wider text-slate-500">Related policies</p>
              <ul className="mt-2 flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:gap-x-6">
                {related.map((page) => (
                  <li key={page.key}>
                    <Link href={page.href} className="font-medium text-emerald-700 hover:text-emerald-800 hover:underline">
                      {page.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </article>
        </div>
      </main>

      <Footer />
    </div>
  );
}
