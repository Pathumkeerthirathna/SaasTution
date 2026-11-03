"use client";

import useErrorReport from "@/components/error-reporting/useErrorReport";

/**
 * Last-resort boundary: the root layout itself failed, so this replaces the
 * whole document (its own <html> and <body>; the app's stylesheet may not
 * be loaded, hence inline styles). The error is reported to the server log;
 * the user sees no technical details.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const reference = useErrorReport(error, "error-boundary:global");

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          boxSizing: "border-box",
          background: "#F8FAFC",
          color: "#0F172A",
          fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <main
          style={{
            width: "100%",
            maxWidth: "420px",
            background: "#FFFFFF",
            border: "1px solid #E2E8F0",
            borderRadius: "16px",
            padding: "28px",
            textAlign: "center",
            boxSizing: "border-box",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>SL Classroom ran into a problem</h1>

          <p style={{ margin: "12px 0 0", fontSize: "14px", lineHeight: 1.6, color: "#475569" }}>
            Something unexpected happened. Reloading the page usually fixes it.
          </p>

          <div style={{ marginTop: "24px", display: "flex", gap: "8px", justifyContent: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                border: 0,
                borderRadius: "8px",
                padding: "10px 16px",
                background: "#112D5C",
                color: "#FFFFFF",
                fontSize: "14px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Reload page
            </button>

            <a
              href="/"
              style={{
                borderRadius: "8px",
                padding: "10px 16px",
                border: "1px solid #CBD5E1",
                color: "#334155",
                fontSize: "14px",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Home
            </a>
          </div>

          {reference && (
            <p style={{ margin: "24px 0 0", fontSize: "12px", color: "#94A3B8" }}>
              Reference: <span style={{ fontFamily: "ui-monospace, monospace" }}>{reference}</span>
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
