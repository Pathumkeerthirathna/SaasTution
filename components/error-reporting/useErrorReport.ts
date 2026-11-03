"use client";

import { useEffect, useState } from "react";

import { reportClientError } from "@/lib/error-logging/client-reporter";

// One report per error object: React runs effects twice in development
// (Strict Mode) and a boundary can re-render; the same reference is shown.
const referenceByError = new WeakMap<object, string>();

/**
 * Error boundaries: reports the caught error once and returns the reference
 * shown to the user (the report's ID, else Next.js's digest).
 */
export default function useErrorReport(error: Error & { digest?: string }, kind: string) {
  const [reference, setReference] = useState<string | null>(null);

  useEffect(() => {
    let id = referenceByError.get(error);

    if (!id) {
      id = reportClientError(error, { source: "react", kind, digest: error.digest }) ?? undefined;

      if (id) referenceByError.set(error, id);
    }

    setReference(id ?? error.digest ?? null);
  }, [error, kind]);

  return reference;
}
