import Link from "next/link";
import { ReactNode } from "react";

type AuthShellProps = {
  title: string;
  subtitle: string;
  footerText: string;
  footerLinkHref: string;
  footerLinkLabel: string;
  children: ReactNode;
};

export function AuthShell({
  title,
  subtitle,
  footerText,
  footerLinkHref,
  footerLinkLabel,
  children,
}: AuthShellProps) {
  return (
    <main className="relative flex min-h-[calc(100vh-4rem)] items-center justify-center overflow-hidden px-4 py-10 sm:px-6">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,_rgba(99,102,241,0.08),transparent_40%),radial-gradient(circle_at_bottom,_rgba(34,197,94,0.08),transparent_45%)]" />

      <section className="w-full max-w-md rounded-3xl border border-black/10 bg-card/95 p-6 shadow-xl backdrop-blur sm:p-8 dark:border-white/10">
        <h1 className="text-2xl font-semibold sm:text-3xl">{title}</h1>
        <p className="mt-2 text-sm text-muted">{subtitle}</p>

        <div className="mt-6">{children}</div>

        <p className="mt-6 text-center text-sm text-muted">
          {footerText}{" "}
          <Link href={footerLinkHref} className="font-semibold text-foreground">
            {footerLinkLabel}
          </Link>
        </p>
      </section>
    </main>
  );
}
