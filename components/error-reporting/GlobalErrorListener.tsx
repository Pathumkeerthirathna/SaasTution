"use client";

import { useEffect } from "react";

import { reportClientError } from "@/lib/error-logging/client-reporter";

/**
 * Reports errors nothing else caught (uncaught exceptions and unhandled
 * promise rejections) to the server's error log. Mounted once in the root
 * layout; renders nothing and changes no behaviour (the browser still logs
 * them to its console). React rendering errors are reported by the error
 * boundaries (app/error.tsx, app/global-error.tsx, route error.tsx files).
 */
export default function GlobalErrorListener() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      reportClientError(event.error ?? event.message, { source: "client", kind: "window-error" });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      reportClientError(event.reason, { source: "client", kind: "unhandled-rejection" });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
