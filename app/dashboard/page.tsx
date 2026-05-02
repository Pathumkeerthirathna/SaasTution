import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export default async function DashboardPage() {
  const cookieStore = cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;

  if (!token) {
    redirect("/login");
  }

  const session = await verifyAuthToken(token);

  if (!session) {
    redirect("/login");
  }

  if (session.role === "ADMIN") {
    redirect("/dashboard/admin");
  }

  if (session.role !== "TEACHER") {
    redirect("/login");
  }

  const teacher = await prisma.teacher.findUnique({
    where: {
      id: session.sub,
    },
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
    },
  });

  if (!teacher) {
    redirect("/login");
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col py-4">
      <section className="rounded-3xl border border-black/10 bg-card p-6 shadow-sm dark:border-white/10 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Teacher Dashboard</p>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">Welcome back, {teacher.name}</h1>
        <p className="mt-2 text-sm text-muted">This route is protected and only available for authenticated teachers.</p>
      </section>

      <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <article className="rounded-2xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Profile</h2>
          <p className="mt-3 text-base font-medium">{teacher.name}</p>
          <p className="text-sm text-muted">{teacher.email}</p>
        </article>

        <article className="rounded-2xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Account Created</h2>
          <p className="mt-3 text-base font-medium">{teacher.createdAt.toLocaleString()}</p>
          <p className="text-sm text-muted">Teacher ID: {teacher.id}</p>
        </article>
      </section>

      <div className="mt-6">
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            href="/dashboard/classes"
            className="inline-flex rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background"
          >
            Manage classes
          </Link>
          <Link
            href="/dashboard/students"
            className="inline-flex rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background"
          >
            Manage students
          </Link>
          <Link
            href="/dashboard/messages"
            className="inline-flex rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background"
          >
            Class messages
          </Link>
          <Link
            href="/dashboard/lectures"
            className="inline-flex rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background"
          >
            Manage lectures
          </Link>
          <Link
            href="/dashboard/sessions"
            className="inline-flex rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background"
          >
            Live sessions
          </Link>
          <Link
            href="/guardian/login"
            className="inline-flex rounded-xl border border-black/10 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
          >
            Guardian portal
          </Link>
          <Link
            href="/"
            className="inline-flex rounded-xl border border-black/10 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
          >
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
