import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ReactNode } from "react";

type AuthShellProps = {
  title: string;
  subtitle: string;
  footerText: string;
  footerLinkHref: string;
  footerLinkLabel: string;
  children: ReactNode;
  /** Optional icon shown next to the title. */
  icon?: ReactNode;
  /** Optional branded panel shown to the left of the form (hidden on mobile). */
  illustration?: ReactNode;
  /** Optional panel rendered to the right of the form, inside the same card. */
  aside?: ReactNode;
  /** Show a subtle "Back to home" link under the footer. */
  showBackToHome?: boolean;
};

export function AuthShell({
  title,
  subtitle,
  footerText,
  footerLinkHref,
  footerLinkLabel,
  children,
  icon,
  illustration,
  aside,
  showBackToHome = false,
}: AuthShellProps) {
  const hasSides = Boolean(illustration) || Boolean(aside);
  const maxWidth =
    illustration && aside ? "max-w-5xl" : hasSides ? "max-w-3xl" : "max-w-sm";

  const formColumn = (
    <>
      <div className="flex items-center gap-2.5">
        {icon ? (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
            {icon}
          </span>
        ) : null}
        <h1 className="text-lg font-bold tracking-tight text-slate-900">{title}</h1>
      </div>
      <p className="mt-1.5 text-[13px] leading-5 text-slate-500">{subtitle}</p>

      <div className="mt-5">{children}</div>

      <div className="mt-5 border-t border-slate-100 pt-4 text-center">
        <p className="text-[13px] text-slate-500">
          {footerText}{" "}
          <Link
            href={footerLinkHref}
            className="font-semibold text-emerald-700 hover:text-emerald-800"
          >
            {footerLinkLabel}
          </Link>
        </p>

        {showBackToHome ? (
          <Link
            href="/"
            className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-slate-400 transition hover:text-emerald-700"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to home
          </Link>
        ) : null}
      </div>
    </>
  );

  return (
    <main className="relative flex min-h-[calc(100vh-4rem)] items-center justify-center overflow-hidden bg-white px-4 py-10 sm:px-6">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.06),transparent_45%),radial-gradient(circle_at_bottom,_rgba(16,185,129,0.05),transparent_50%)]" />

      <section
        className={`relative w-full overflow-hidden rounded-2xl border border-emerald-100 bg-white shadow-[0_10px_40px_-15px_rgba(16,185,129,0.25)] ${maxWidth}`}
      >
        <span className="absolute inset-x-0 top-0 z-10 h-1 bg-gradient-to-r from-emerald-500 via-emerald-500 to-emerald-400" />

        {hasSides ? (
          <div className="flex flex-col lg:flex-row lg:items-stretch">
            {illustration ? (
              <div className="hidden lg:block lg:flex-1">{illustration}</div>
            ) : null}

            <div
              className={`p-6 sm:p-7 lg:w-[340px] lg:shrink-0 ${
                illustration ? "border-t border-slate-100 lg:border-l lg:border-t-0" : ""
              }`}
            >
              {formColumn}
            </div>

            {aside ? (
              <div className="border-t border-slate-200 p-6 pt-5 sm:p-7 lg:min-w-0 lg:flex-1 lg:border-l lg:border-t-0">
                {aside}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="p-6 sm:p-7">{formColumn}</div>
        )}
      </section>
    </main>
  );
}
