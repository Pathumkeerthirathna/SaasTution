import Link from "next/link";

export default function SessionEndedPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-10 sm:px-6 lg:px-8">
      <section className="rounded-3xl border border-black/10 bg-card p-6 shadow-sm dark:border-white/10 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Live Session</p>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">Class has ended</h1>
        <p className="mt-3 text-sm text-muted sm:text-base">
          Your teacher ended this session. You can return to the portal and join again when a new class starts.
        </p>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-xl bg-foreground px-4 py-2.5 text-sm font-semibold text-background"
          >
            Go to home
          </Link>
          <Link
            href="/guardian/dashboard"
            className="inline-flex items-center justify-center rounded-xl border border-black/10 px-4 py-2.5 text-sm font-semibold hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
          >
            Open guardian dashboard
          </Link>
        </div>
      </section>
    </main>
  );
}
