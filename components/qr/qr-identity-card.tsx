"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, Maximize2, Printer, QrCode, RefreshCw, ShieldAlert } from "lucide-react";

import { QrEnlargeDialog } from "@/components/qr/qr-enlarge-dialog";

/*
 * Shared QR identity card: the student's own "My Attendance QR" on My Profile
 * (components/student-portal/student-qr-panel.tsx) and the teacher's student
 * profile tab (app/student/Components/StudentQrIdentity.tsx).
 *
 * Display-only unless a regenerate endpoint is given: the student card
 * (Student Profile SP-4) passes none, so it shows the QR and Download only:
 * no Print, no Regenerate button, no confirmation, no regeneration counts.
 * The teacher card passes one and keeps every action. (The regeneration API
 * itself is unchanged; this only decides what the UI offers.)
 *
 * A QR is never created by viewing it: when the status says there is no
 * active QR, the card first issues one explicitly (same-origin POST to the
 * issue endpoint), then reads the PNG with a read-only GET.
 *
 * The QR image is fetched as a blob and shown through an in-memory object URL:
 * the token never appears in a URL, in browser storage or in the page's HTML.
 * Download and print reuse that blob; nothing is cached (the API answers
 * no-store). Authorization is entirely server-side: the endpoints decide
 * whose QR this is (the session's own student, or a student the signed-in
 * teacher owns).
 */

export type QrIdentityEndpoints = {
  status: string;
  /** POST: issues the first QR (idempotent). GET image never issues. */
  issue: string;
  image: string;
  /** Omitted: display-only (view and download). */
  regenerate?: string;
};

/** A failed QR request, keeping the status and API error code. */
class QrRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

type QrStatus = {
  configured: boolean;
  hasActiveToken: boolean;
  regenerationLimit: number;
  regenerationsRemaining: number;
  nextRegenerationAt: string | null;
};

type ApiFailure = { success: false; error?: { message?: string; code?: string; details?: { retryAt?: string } } };

type Notice = { tone: "success" | "error"; text: string } | null;

type Variant = "student" | "teacher";

const STYLES: Record<Variant, { frame: string; primary: string; secondary: string; quota: string }> = {
  student: {
    frame: "border-brand-200",
    primary: "bg-brand-700 text-white hover:bg-brand-800",
    secondary: "border border-brand-200 bg-white text-brand-700 hover:bg-brand-50",
    quota: "border-slate-200 bg-slate-50",
  },
  teacher: {
    frame: "border-slate-200",
    primary: "bg-[#4D6C90] text-white hover:bg-[#3B5776]",
    secondary: "border border-slate-300 bg-white text-[#3B5776] hover:bg-slate-50",
    quota: "border-slate-200 bg-slate-50",
  },
};

type RegenerationCopy = {
  confirm: string;
  success: string;
  limitWithTime: (when: string) => string;
  limit: string;
  nextAllowed: (when: string) => string;
  footnote: string;
};

const COPY: Record<Variant, { unavailable: string; download: string; footnote: string }> = {
  student: {
    unavailable: "QR codes are not available right now. Please try again later or contact your teacher.",
    download: "Download QR Code",
    footnote: "If your QR code is lost or shared with someone else, ask your teacher for a new one.",
  },
  teacher: {
    unavailable: "QR codes are not available right now. Student QR codes are not configured on this server.",
    download: "Download QR",
    footnote: "",
  },
};

/** Regeneration wording exists for the teacher card only (the student card is display-only). */
const REGENERATION_COPY: Partial<Record<Variant, RegenerationCopy>> = {
  teacher: {
    confirm:
      "The student's current QR code will stop working immediately, including printed or downloaded copies. Give the student the new one.",
    success: "The QR code was regenerated. The old QR code no longer works — download or print the new one for the student.",
    limitWithTime: (when) => `This student's regeneration limit has been reached. It can be regenerated again after ${when}.`,
    limit: "This student's regeneration limit has been reached. Please try again later.",
    nextAllowed: (when) => `Can be regenerated again after ${when}.`,
    footnote:
      "Regenerate only if the student's QR code was lost or shared. The student can also regenerate it from their Settings; both count towards the same limit.",
  },
};

const SESSION_EXPIRED = "Your session has expired. Please sign in again.";

function formatSriLankaTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Colombo",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

async function readFailure(response: Response): Promise<ApiFailure | null> {
  try {
    return (await response.json()) as ApiFailure;
  } catch {
    return null;
  }
}

/** File name for downloads, built from data the page already shows. */
function downloadName(registrationNumber: string | null): string {
  const safe = (registrationNumber ?? "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return safe ? `qr-${safe}.png` : "student-qr-code.png";
}

export type QrIdentityCardProps = {
  variant: Variant;
  endpoints: QrIdentityEndpoints;
  studentName: string;
  registrationNumber: string | null;
  /**
   * Opt-in (the student's own card only): the QR can be enlarged in a modal
   * that reuses the loaded image. Omitted: the card renders exactly as before.
   */
  enlargeable?: boolean;
};

export function QrIdentityCard({ variant, endpoints, studentName, registrationNumber, enlargeable = false }: QrIdentityCardProps) {
  const styles = STYLES[variant];
  const copy = COPY[variant];
  const regenerateEndpoint = endpoints.regenerate;
  const regenCopy = REGENERATION_COPY[variant];
  // Regeneration (and Print) only where a regenerate endpoint is given: the teacher card.
  const canRegenerate = Boolean(regenerateEndpoint && regenCopy);
  const footnote = canRegenerate && regenCopy ? regenCopy.footnote : copy.footnote;

  const [status, setStatus] = useState<QrStatus | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [enlarged, setEnlarged] = useState(false);
  const imageUrlRef = useRef<string | null>(null);
  // Replaced object URLs, revoked once the new image has loaded (revoking a
  // URL an <img> is still loading would fail that load).
  const staleUrlsRef = useRef<string[]>([]);

  const messageFor = useCallback(
    (status: number, fallback: string) => {
      if (status === 401) return SESSION_EXPIRED;
      if (status === 503) return copy.unavailable;
      return fallback;
    },
    [copy.unavailable]
  );

  const revokeStale = useCallback(() => {
    for (const url of staleUrlsRef.current) URL.revokeObjectURL(url);
    staleUrlsRef.current = [];
  }, []);

  const replaceImage = useCallback(
    (blob: Blob | null) => {
      if (imageUrlRef.current) staleUrlsRef.current.push(imageUrlRef.current);
      imageUrlRef.current = blob ? URL.createObjectURL(blob) : null;
      setImageUrl(imageUrlRef.current);
      if (!blob) revokeStale(); // nothing shown any more
    },
    [revokeStale]
  );

  useEffect(
    () => () => {
      revokeStale();
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    },
    [revokeStale]
  );

  const loadStatus = useCallback(async (): Promise<QrStatus | null> => {
    const response = await fetch(endpoints.status, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) {
      if (response.status === 401) setSessionExpired(true);
      const failure = await readFailure(response);
      throw new Error(messageFor(response.status, failure?.error?.message ?? "Could not load the QR status."));
    }
    const body = (await response.json()) as { data: QrStatus };
    setStatus(body.data);
    return body.data;
  }, [endpoints.status, messageFor]);

  const loadImage = useCallback(async () => {
    const response = await fetch(endpoints.image, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/png")) {
      if (response.status === 401) setSessionExpired(true);
      const failure = await readFailure(response);
      throw new QrRequestError(
        messageFor(response.status, failure?.error?.message ?? "Could not load the QR code."),
        response.status,
        failure?.error?.code
      );
    }
    replaceImage(await response.blob());
  }, [endpoints.image, messageFor, replaceImage]);

  /** Explicit, idempotent issuance of the first QR (never counts towards the limit). */
  const issueQr = useCallback(async () => {
    const response = await fetch(endpoints.issue, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      if (response.status === 401) setSessionExpired(true);
      const failure = await readFailure(response);
      throw new QrRequestError(
        messageFor(response.status, failure?.error?.message ?? "Could not create the QR code."),
        response.status,
        failure?.error?.code
      );
    }
    const body = (await response.json()) as { data: QrStatus };
    setStatus(body.data);
  }, [endpoints.issue, messageFor]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const current = await loadStatus();
      if (current && !current.configured) {
        replaceImage(null);
        setLoadError(copy.unavailable);
        return;
      }
      if (current && !current.hasActiveToken) await issueQr();
      try {
        await loadImage();
      } catch (error) {
        // Revoked / missing in between (e.g. another tab): issue once, then retry.
        if (!(error instanceof QrRequestError) || error.code !== "QR_TOKEN_NOT_FOUND") throw error;
        await issueQr();
        await loadImage();
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load the QR code.");
    } finally {
      setLoading(false);
    }
  }, [copy.unavailable, issueQr, loadImage, loadStatus, replaceImage]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleDownload = useCallback(() => {
    if (!imageUrlRef.current) return;
    const link = document.createElement("a");
    link.href = imageUrlRef.current;
    // A student downloads their own "my-qr-code.png"; a teacher gets one per student.
    link.download = variant === "teacher" ? downloadName(registrationNumber) : "my-qr-code.png";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [registrationNumber, variant]);

  const handlePrint = useCallback(() => {
    const source = imageUrlRef.current;
    if (!source) return;

    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.position = "fixed";
    frame.style.right = "0";
    frame.style.bottom = "0";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    document.body.appendChild(frame);

    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) {
      frame.remove();
      return;
    }

    // Built with DOM APIs (textContent): the name is never parsed as HTML.
    doc.open();
    doc.write("<!doctype html><html><head><title>QR code</title></head><body></body></html>");
    doc.close();
    const style = doc.createElement("style");
    style.textContent =
      "@page{margin:16mm}body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#0f172a;display:flex;justify-content:center}" +
      ".card{display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px;border:1px solid #cbd5e1;border-radius:12px}" +
      "img{width:70mm;height:70mm;image-rendering:pixelated}.name{font-size:18px;font-weight:700}.reg{font-size:14px;color:#475569}";
    doc.head.appendChild(style);
    const card = doc.createElement("div");
    card.className = "card";
    const image = doc.createElement("img");
    image.alt = "QR code";
    const name = doc.createElement("div");
    name.className = "name";
    name.textContent = studentName;
    card.append(image, name);
    if (registrationNumber) {
      const reg = doc.createElement("div");
      reg.className = "reg";
      reg.textContent = `Registration No: ${registrationNumber}`;
      card.append(reg);
    }
    doc.body.appendChild(card);

    image.onload = () => {
      win.focus();
      win.print();
      window.setTimeout(() => frame.remove(), 1000);
    };
    image.onerror = () => frame.remove();
    image.src = source;
  }, [registrationNumber, studentName]);

  const handleRegenerate = useCallback(async () => {
    if (!regenerateEndpoint || !regenCopy) return; // display-only card: nothing to send
    setRegenerating(true);
    setNotice(null);
    try {
      const response = await fetch(regenerateEndpoint, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        const failure = await readFailure(response);
        if (response.status === 401) setSessionExpired(true);
        if (response.status === 429) {
          const retryAt = failure?.error?.details?.retryAt;
          const when = retryAt ? formatSriLankaTime(retryAt) : "";
          setNotice({ tone: "error", text: when ? regenCopy.limitWithTime(when) : regenCopy.limit });
          await loadStatus().catch(() => undefined);
          return;
        }
        setNotice({
          tone: "error",
          text: messageFor(response.status, failure?.error?.message ?? "Could not regenerate the QR code."),
        });
        return;
      }

      const body = (await response.json()) as { data: QrStatus };
      setStatus(body.data);
      await loadImage();
      setNotice({ tone: "success", text: regenCopy.success });
    } catch {
      setNotice({ tone: "error", text: "Could not regenerate the QR code. Please check your connection and try again." });
    } finally {
      setRegenerating(false);
      setConfirming(false);
    }
  }, [regenCopy, regenerateEndpoint, loadImage, loadStatus, messageFor]);

  const limitReached = Boolean(status && status.regenerationsRemaining <= 0);
  const nextAllowed = status?.nextRegenerationAt ? formatSriLankaTime(status.nextRegenerationAt) : "";
  const canAct = Boolean(imageUrl) && !loading && !sessionExpired;
  const canEnlarge = enlargeable && canAct;
  const buttonBase =
    "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  const qrImage = imageUrl ? (
    // A blob: URL of the private PNG; next/image cannot load it.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={imageUrl}
      alt={`QR code for ${studentName}`}
      className="h-full w-full object-contain [image-rendering:pixelated]"
      data-testid="student-qr-image"
      onLoad={revokeStale}
    />
  ) : null;

  return (
    <div className="flex flex-col gap-6 md:flex-row md:items-start">
      <div className="flex w-full flex-col items-center gap-3 md:w-auto">
        <div
          className={`flex aspect-square w-full max-w-[260px] items-center justify-center rounded-2xl border bg-white p-3 shadow-sm ${styles.frame}`}
        >
          {loading ? (
            <div className="flex flex-col items-center gap-2 text-sm text-slate-500" role="status">
              <Loader2 className="h-6 w-6 animate-spin text-slate-500" aria-hidden />
              Loading QR code…
            </div>
          ) : qrImage ? (
            canEnlarge ? (
              <button
                type="button"
                onClick={() => setEnlarged(true)}
                aria-label="Enlarge QR code"
                aria-haspopup="dialog"
                className="h-full w-full cursor-zoom-in rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700"
                data-testid="student-qr-enlarge-image"
              >
                {qrImage}
              </button>
            ) : (
              qrImage
            )
          ) : (
            <div className="flex flex-col items-center gap-2 px-2 text-center text-sm text-slate-500">
              <QrCode className="h-8 w-8 text-slate-400" aria-hidden />
              QR code unavailable
            </div>
          )}
        </div>
        <div className="text-center">
          <p className="break-words font-semibold text-slate-900" data-testid="student-qr-name">
            {studentName}
          </p>
          <p className="break-words text-sm text-slate-600" data-testid="student-qr-registration">
            {registrationNumber ? `Registration No: ${registrationNumber}` : "Registration number not assigned yet"}
          </p>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-4">
        {loadError && (
          <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
            <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
            <div className="min-w-0">
              <p>{loadError}</p>
              {sessionExpired ? (
                <a href="/login" className="font-semibold underline">
                  Sign in again
                </a>
              ) : (
                <button type="button" onClick={() => void loadAll()} className="font-semibold underline">
                  Try again
                </button>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button type="button" onClick={handleDownload} disabled={!canAct} className={`${buttonBase} ${styles.primary}`}>
            <Download className="h-4 w-4" aria-hidden />
            {copy.download}
          </button>
          {enlargeable && (
            <button
              type="button"
              onClick={() => setEnlarged(true)}
              disabled={!canEnlarge}
              aria-haspopup="dialog"
              className={`${buttonBase} ${styles.secondary}`}
            >
              <Maximize2 className="h-4 w-4" aria-hidden />
              Enlarge QR Code
            </button>
          )}
          {canRegenerate && (
            <>
              <button type="button" onClick={handlePrint} disabled={!canAct} className={`${buttonBase} ${styles.secondary}`}>
                <Printer className="h-4 w-4" aria-hidden />
                Print QR
              </button>
              <button
                type="button"
                onClick={() => {
                  setNotice(null);
                  setConfirming(true);
                }}
                disabled={!canAct || regenerating || limitReached || confirming}
                className={`${buttonBase} border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100`}
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                Regenerate QR
              </button>
            </>
          )}
        </div>

        {canRegenerate && regenCopy && confirming && (
          <div
            className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
            role="alertdialog"
            aria-labelledby="qr-regenerate-title"
          >
            <p id="qr-regenerate-title" className="font-semibold">
              Regenerate this QR code?
            </p>
            <p className="mt-1">{regenCopy.confirm}</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => void handleRegenerate()}
                disabled={regenerating}
                className={`${buttonBase} bg-amber-600 text-white hover:bg-amber-700`}
              >
                {regenerating && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {regenerating ? "Regenerating…" : "Yes, regenerate"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={regenerating}
                className={`${buttonBase} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {notice && (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            className={`rounded-xl border px-3 py-2 text-sm ${
              notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-700"
            }`}
            data-testid="student-qr-notice"
          >
            {notice.text}
            {notice.tone === "error" && sessionExpired && (
              <>
                {" "}
                <a href="/login" className="font-semibold underline">
                  Sign in again
                </a>
              </>
            )}
          </p>
        )}

        {canRegenerate && regenCopy && status && status.configured && (
          <div className={`rounded-xl border px-3 py-2 text-sm text-slate-700 ${styles.quota}`} data-testid="student-qr-quota">
            <p>
              Regenerations left:{" "}
              <span className="font-semibold text-slate-900">
                {status.regenerationsRemaining} of {status.regenerationLimit}
              </span>{" "}
              in the last 24 hours.
            </p>
            {limitReached && nextAllowed && <p className="mt-1 text-amber-800">{regenCopy.nextAllowed(nextAllowed)}</p>}
          </div>
        )}

        {footnote ? <p className="text-xs text-slate-500">{footnote}</p> : null}
      </div>

      {enlarged && canEnlarge && imageUrl && (
        <QrEnlargeDialog
          imageUrl={imageUrl}
          studentName={studentName}
          registrationNumber={registrationNumber}
          onClose={() => setEnlarged(false)}
        />
      )}
    </div>
  );
}
