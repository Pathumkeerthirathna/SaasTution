"use client";

import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useMemo, useState } from "react";

import { StudentSidebar } from "@/components/student-portal/student-sidebar";
import { studentNavItems } from "@/components/student-portal/student-data";

type StudentShellProps = {
  studentName: string;
  studentEmail: string | null;
  registrationNumber: string | null;
  children: ReactNode;
};

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/);

  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

export function StudentShell({ studentName, studentEmail, registrationNumber, children }: StudentShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const activePath = useMemo(() => {
    if (!pathname) {
      return "/student/dashboard";
    }

    const exact = studentNavItems.find((item) => item.href === pathname);
    if (exact) {
      return exact.href;
    }

    const settingsPrefix = pathname.startsWith("/student/settings") || pathname.startsWith("/account/security");
    if (settingsPrefix) {
      return "/student/settings";
    }

    return "/student/dashboard";
  }, [pathname]);

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
      setIsProfileOpen(false);
    }
  }

  return (
    <div className="min-h-screen bg-background-soft text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-[1450px]">
        <StudentSidebar
          items={studentNavItems}
          activePath={activePath}
          open={isSidebarOpen}
          onClose={() => setIsSidebarOpen(false)}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 border-b border-brand-200/80 bg-background/95 px-4 py-3 backdrop-blur sm:px-6 lg:px-8">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label="Toggle sidebar"
                  onClick={() => setIsSidebarOpen((prev) => !prev)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-brand-300 bg-card text-slate-700 lg:hidden"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
                  </svg>
                </button>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-700">Student Portal</p>
                  <h1 className="text-lg font-semibold text-slate-900 sm:text-xl">Welcome, {studentName}</h1>
                </div>
              </div>

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsProfileOpen((prev) => !prev)}
                  className="inline-flex items-center gap-2 rounded-xl border border-brand-300 bg-card px-3 py-2 text-sm font-medium text-slate-800 shadow-soft"
                  aria-haspopup="menu"
                  aria-expanded={isProfileOpen}
                >
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand-700 text-xs font-semibold text-white">
                    {getInitials(studentName)}
                  </span>
                  <span className="hidden text-left sm:inline">
                    <span className="block text-xs text-slate-500">Student details</span>
                    <span className="block max-w-[10rem] truncate font-semibold text-slate-900">{studentName}</span>
                  </span>
                </button>

                {isProfileOpen ? (
                  <div className="absolute right-0 mt-2 w-72 rounded-2xl border border-brand-200 bg-card p-4 shadow-panel">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-700">Student Account</p>
                    <p className="mt-2 text-base font-semibold text-slate-900">{studentName}</p>
                    <p className="text-sm text-slate-600">{studentEmail ?? "No email"}</p>
                    <p className="mt-1 text-sm text-slate-600">Reg No: {registrationNumber ?? "-"}</p>

                    <button
                      type="button"
                      onClick={handleSignOut}
                      disabled={isSigningOut}
                      className="btn-primary mt-4 w-full bg-accent hover:brightness-105"
                    >
                      {isSigningOut ? "Logging out..." : "Logout"}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </header>

          <main className="flex-1 space-y-7 px-4 py-7 sm:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
