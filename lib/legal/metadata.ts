import type { Metadata } from "next";

import { LEGAL_DOCUMENT_STATUS, LEGAL_PLATFORM } from "@/lib/legal/config";

/**
 * Metadata of a legal page. The canonical URL is resolved against the root
 * layout's metadataBase (lib/site-url.ts). While the documents are drafts
 * (LEGAL_DOCUMENT_STATUS.isDraft) the pages are noindex, so an unreviewed
 * draft is never listed by search engines; links on them are still followed.
 */
export function legalPageMetadata({
  path,
  title,
  description,
}: {
  path: "/terms" | "/privacy" | "/refund-policy";
  title: string;
  description: string;
}): Metadata {
  const fullTitle = `${LEGAL_PLATFORM.name} ${title}`;
  return {
    // Absolute: the root template would add "| SL Classroom" a second time.
    title: { absolute: fullTitle },
    description,
    alternates: { canonical: path },
    robots: LEGAL_DOCUMENT_STATUS.isDraft ? { index: false, follow: true } : { index: true, follow: true },
    // A page's openGraph replaces the root layout's, so siteName and locale are repeated here.
    openGraph: {
      title: fullTitle,
      description,
      url: path,
      type: "website",
      siteName: LEGAL_PLATFORM.name,
      locale: "en_LK",
    },
  };
}
