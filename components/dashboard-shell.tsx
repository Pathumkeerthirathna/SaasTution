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
      { href: "/dashboard/material-bundles", label: "Tutes & Papers" },
      { href: "/dashboard/material-bundles/configuration", label: "Paper Configuration" },
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
      <div className="mx-auto flex min-h-screen w-full max-w-[1440px]">
        <aside
          className={`fixed inset-y-0 left-0 z-40 w-72 border-r border-brand-200/90 bg-card p-6 shadow-panel transition-transform duration-220 lg:static lg:translate-x-0 lg:shadow-none ${
            isSidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="mb-8 border-b border-brand-200/70 pb-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-700">SaasTution Panel</p>
            <h2 className="mt-2 text-xl font-semibold text-slate-900">{role === "ADMIN" ? "Admin Console" : "Teacher Workspace"}</h2>
            <p className="mt-2 text-sm text-slate-600">Manage classes, delivery status, and teaching operations.</p>
          </div>

          <nav className="space-y-1.5">
            {navItems.map((item) => {
              const isActive = pathname === item.href;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setIsSidebarOpen(false)}
                  className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-all duration-180 ${
                    isActive
                      ? "bg-brand-700 text-white shadow-soft"
                      : "text-slate-700 hover:bg-brand-50 hover:text-brand-800"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 rounded-full ${isActive ? "bg-white" : "bg-brand-300"}`}
                  />
                  <span>{item.label}</span>
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
          <header className="sticky top-0 z-20 border-b border-brand-200/80 bg-background/95 px-4 py-3 backdrop-blur sm:px-6 lg:px-8">
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
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-700">Professional Dashboard</p>
                  <p className="text-sm text-slate-700">Clean, focused control for your daily teaching workflow</p>
                </div>
              </div>

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsProfileOpen((prev) => !prev)}
                  className="inline-flex items-center gap-2 rounded-xl border border-brand-300 bg-card px-3 py-2 text-sm font-medium text-slate-800 shadow-soft"
                >
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand-700 text-xs font-semibold text-white">
                    {getInitials(name)}
                  </span>
                  <span className="hidden sm:inline">{name}</span>
                </button>

                {isProfileOpen ? (
                  <div className="absolute right-0 mt-2 w-72 rounded-2xl border border-brand-200 bg-card p-4 shadow-panel">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-700">Logged In User</p>
                    <p className="mt-2 text-base font-semibold text-slate-900">{name}</p>
                    <p className="text-sm text-slate-600">{email}</p>
                    <p className="mt-1 text-sm text-slate-600">Role: {role}</p>

                    <Link
                      href="/account/security"
                      className="btn-secondary mt-3 w-full"
                    >
                      Change password
                    </Link>

                    <button
                      type="button"
                      onClick={handleSignOut}
                      disabled={isSigningOut}
                      className="btn-primary mt-3 w-full bg-accent hover:brightness-105"
                    >
                      {isSigningOut ? "Signing out..." : "Sign out"}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </header>

          <main className="flex-1 px-4 py-7 sm:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
