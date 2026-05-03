"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useMemo, useState } from "react";

type DashboardShellProps = {
  role: "TEACHER" | "ADMIN";
  name: string;
  email: string;
  children: ReactNode;
};

type NavItem = {
  href: string;
  label: string;
};
//
function getInitials(name: string) {
  const parts = name.trim().split(/\s+/);

  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

export function DashboardShell({ role, name, email, children }: DashboardShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const navItems = useMemo<NavItem[]>(() => {
    if (role === "ADMIN") {
      return [{ href: "/dashboard/admin", label: "Admin Overview" }];
    }

    return [
      { href: "/dashboard", label: "Overview" },
      { href: "/dashboard/classes", label: "Classes" },
      { href: "/dashboard/students", label: "Students" },
      { href: "/dashboard/messages", label: "Messages" },
      { href: "/dashboard/lectures", label: "Lectures" },
      { href: "/dashboard/sessions", label: "Live Sessions" },
    ];
  }, [role]);

  async function handleSignOut() {
    setIsSigningOut(true);

    try {
      await fetch("/api/auth/logout", {
        method: "POST",
      });
    } finally {
      router.push("/login");
      router.refresh();
      setIsSigningOut(false);
    }
  }

  return (
    <div className="min-h-screen bg-background-soft text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-[1400px]">
        <aside
          className={`fixed inset-y-0 left-0 z-40 w-72 border-r border-brand-200 bg-card p-5 shadow-xl transition-transform duration-300 lg:static lg:translate-x-0 lg:shadow-none ${
            isSidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="mb-8">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-700">SaasTution Panel</p>
            <h2 className="mt-2 text-xl font-semibold text-slate-900">{role === "ADMIN" ? "Admin Console" : "Teacher Workspace"}</h2>
          </div>

          <nav className="space-y-2">
            {navItems.map((item) => {
              const isActive = pathname === item.href;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setIsSidebarOpen(false)}
                  className={`block rounded-xl px-4 py-2.5 text-sm font-medium transition ${
                    isActive
                      ? "bg-brand-700 text-white"
                      : "text-slate-700 hover:bg-brand-100 hover:text-brand-800"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>

        {isSidebarOpen ? (
          <button
            type="button"
            aria-label="Close sidebar"
            className="fixed inset-0 z-30 bg-slate-900/30 lg:hidden"
            onClick={() => setIsSidebarOpen(false)}
          />
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 border-b border-brand-200 bg-background/95 px-4 py-3 backdrop-blur sm:px-6 lg:px-8">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setIsSidebarOpen((prev) => !prev)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-brand-300 bg-card text-slate-700 lg:hidden"
                  aria-label="Toggle sidebar"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
                  </svg>
                </button>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">Professional Dashboard</p>
                  <p className="text-sm text-slate-700">Manage classes, users, and visibility in one place</p>
                </div>
              </div>

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsProfileOpen((prev) => !prev)}
                  className="inline-flex items-center gap-2 rounded-xl border border-brand-300 bg-card px-3 py-2 text-sm font-medium text-slate-800"
                >
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand-700 text-xs font-semibold text-white">
                    {getInitials(name)}
                  </span>
                  <span className="hidden sm:inline">{name}</span>
                </button>

                {isProfileOpen ? (
                  <div className="absolute right-0 mt-2 w-72 rounded-2xl border border-brand-200 bg-card p-4 shadow-2xl">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-700">Logged In User</p>
                    <p className="mt-2 text-base font-semibold text-slate-900">{name}</p>
                    <p className="text-sm text-slate-600">{email}</p>
                    <p className="mt-1 text-sm text-slate-600">Role: {role}</p>

                    <Link
                      href="/account/security"
                      className="mt-3 inline-flex w-full items-center justify-center rounded-xl border border-brand-300 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-brand-50"
                    >
                      Change password
                    </Link>

                    <button
                      type="button"
                      onClick={handleSignOut}
                      disabled={isSigningOut}
                      className="mt-4 w-full rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
                    >
                      {isSigningOut ? "Signing out..." : "Sign out"}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </header>

          <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
