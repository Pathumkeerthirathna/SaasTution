"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, Printer, QrCode, RefreshCw, ShieldAlert } from "lucide-react";

import { Panel } from "@/components/student-portal/student-ui";

/*
 * "My QR Identity" (Student Settings). The QR image is fetched as a blob and
 * shown through an in-memory object URL: the token never appears in a URL,
 * in browser storage or in the page's HTML. Download and print reuse that
 * blob; nothing is cached (the API answers no-store).
 */

type QrStatus = {
  configured: boolean;
  hasActiveToken: boolean;
  regenerationLimit: number;
  regenerationsRemaining: number;
  nextRegenerationAt: string | null;
};

type ApiFailure = { success: false; error?: { message?: string; code?: string; details?: { retryAt?: string } } };

type Notice = { tone: "success" | "error" | "info"; text: string } | null;

const STATUS_URL = "/api/students/me/qr/status";
const IMAGE_URL = "/api/students/me/qr";
const REGENERATE_URL = "/api/students/me/qr/regenerate";

const SESSION_EXPIRED = "Your session has expired. Please sign in again.";
const NOT_AVAILABLE = "QR codes are not available right now. Please try again later or contact your teacher.";

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

function messageForStatus(status: number, fallback: string): string {
  if (status === 401) return SESSION_EXPIRED;
  if (status === 503) return NOT_AVAILABLE;
  return fallback;
}

async function readFailure(response: Response): Promise<ApiFailure | null> {
  try {
    return (await response.json()) as ApiFailure;
  } catch {
    return null;
  }
}

type StudentQrPanelProps = {
  studentName: string;
  registrationNumber: string | null;
};

export function StudentQrPanel({ studentName, registrationNumber }: StudentQrPanelProps) {
  const [status, setStatus] = useState<QrStatus | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const imageUrlRef = useRef<string | null>(null);
  const blobRef = useRef<Blob | null>(null);

  const replaceImage = useCallback((blob: Blob | null) => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    blobRef.current = blob;
    imageUrlRef.current = blob ? URL.createObjectURL(blob) : null;
    setImageUrl(imageUrlRef.current);
  }, []);

  useEffect(
    () => () => {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    },
    []
  );

  const loadStatus = useCallback(async (): Promise<QrStatus | null> => {
    const response = await fetch(STATUS_URL, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) {
      if (response.status === 401) setSessionExpired(true);
      const failure = await readFailure(response);
      throw new Error(messageForStatus(response.status, failure?.error?.message ?? "Could not load your QR status."));
    }
    const body = (await response.json()) as { data: QrStatus };
    setStatus(body.data);
    return body.data;
  }, []);

  const loadImage = useCallback(async () => {
    const response = await fetch(IMAGE_URL, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/png")) {
      if (response.status === 401) setSessionExpired(true);
      const failure = await readFailure(response);
      throw new Error(messageForStatus(response.status, failure?.error?.message ?? "Could not load your QR code."));
    }
    replaceImage(await response.blob());
  }, [replaceImage]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const current = await loadStatus();
      if (current && !current.configured) {
        replaceImage(null);
        setLoadError(NOT_AVAILABLE);
        return;
      }
      await loadImage();
      // The first view may just have issued the QR: refresh the status.
      if (current && !current.hasActiveToken) await loadStatus();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load your QR code.");
    } finally {
      setLoading(false);
    }
  }, [loadImage, loadStatus, replaceImage]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleDownload = useCallback(() => {
    if (!imageUrlRef.current) return;
    const link = document.createElement("a");
    link.href = imageUrlRef.current;
    link.download = "my-qr-code.png";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, []);

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
    doc.write("<!doctype html><html><head><title>My QR code</title></head><body></body></html>");
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
    image.alt = "My QR code";
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

    const cleanup = () => window.setTimeout(() => frame.remove(), 1000);
    image.onload = () => {
      win.focus();
      win.print();
      cleanup();
    };
    image.onerror = () => frame.remove();
    image.src = source;
  }, [registrationNumber, studentName]);

  const handleRegenerate = useCallback(async () => {
    setRegenerating(true);
    setNotice(null);
    try {
      const response = await fetch(REGENERATE_URL, {
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
          setNotice({
            tone: "error",
            text: when
              ? `You have reached the regeneration limit. You can regenerate again after ${when}.`
              : "You have reached the regeneration limit. Please try again later.",
          });
          await loadStatus().catch(() => undefined);
          return;
        }
        setNotice({
          tone: "error",
          text: messageForStatus(response.status, failure?.error?.message ?? "Could not regenerate your QR code."),
        });
        return;
      }

      const body = (await response.json()) as { data: QrStatus };
      setStatus(body.data);
      await loadImage();
      setNotice({
        tone: "success",
        text: "Your QR code was regenerated. The old QR code no longer works — download or print the new one.",
      });
    } catch {
      setNotice({ tone: "error", text: "Could not regenerate your QR code. Please check your connection and try again." });
    } finally {
      setRegenerating(false);
      setConfirming(false);
    }
  }, [loadImage, loadStatus]);

  const limitReached = Boolean(status && status.regenerationsRemaining <= 0);
  const nextAllowed = status?.nextRegenerationAt ? formatSriLankaTime(status.nextRegenerationAt) : "";
  const canAct = Boolean(imageUrl) && !loading && !sessionExpired;

  return (
    <Panel
      id="my-qr-identity"
      title="My QR Identity"
      subtitle="Your personal QR code. Keep it private — anyone with it can identify as you."
    >
      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <div className="flex w-full flex-col items-center gap-3 md:w-auto">
          <div className="flex aspect-square w-full max-w-[260px] items-center justify-center rounded-2xl border border-brand-200 bg-white p-3 shadow-sm">
            {loading ? (
              <div className="flex flex-col items-center gap-2 text-sm text-slate-500" role="status">
                <Loader2 className="h-6 w-6 animate-spin text-brand-600" aria-hidden />
                Loading your QR code…
              </div>
            ) : imageUrl ? (
              // A blob: URL of the private PNG; next/image cannot load it.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl}
                alt={`QR code for ${studentName}`}
                className="h-full w-full object-contain [image-rendering:pixelated]"
                data-testid="student-qr-image"
              />
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
            <button
              type="button"
              onClick={handleDownload}
              disabled={!canAct}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="h-4 w-4" aria-hidden />
              Download QR
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={!canAct}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-brand-200 bg-white px-4 py-2 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
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
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-800 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Regenerate QR
            </button>
          </div>

          {confirming && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="alertdialog" aria-labelledby="qr-regenerate-title">
              <p id="qr-regenerate-title" className="font-semibold">
                Regenerate your QR code?
              </p>
              <p className="mt-1">
                Your current QR code will stop working immediately, including printed or downloaded copies.
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={() => void handleRegenerate()}
                  disabled={regenerating}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-60"
                >
                  {regenerating && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  {regenerating ? "Regenerating…" : "Yes, regenerate"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={regenerating}
                  className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
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
                notice.tone === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : notice.tone === "error"
                    ? "border-rose-200 bg-rose-50 text-rose-700"
                    : "border-brand-200 bg-brand-50 text-brand-800"
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

          {status && status.configured && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700" data-testid="student-qr-quota">
              <p>
                Regenerations left:{" "}
                <span className="font-semibold text-slate-900">
                  {status.regenerationsRemaining} of {status.regenerationLimit}
                </span>{" "}
                in the last 24 hours.
              </p>
              {limitReached && nextAllowed && (
                <p className="mt-1 text-amber-800">You can regenerate again after {nextAllowed}.</p>
              )}
            </div>
          )}

          <p className="text-xs text-slate-500">
            Regenerate only if your QR code was lost or shared. Your teacher can also regenerate it; both count towards
            the same limit.
          </p>
        </div>
      </div>
    </Panel>
  );
}
