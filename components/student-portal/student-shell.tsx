"use client";

import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useMemo, useState } from "react";
import { Menu, LogOut, ChevronDown, Hash } from "lucide-react";

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
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

export function StudentShell({ studentName, studentEmail, registrationNumber, children }: StudentShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const activePath = useMemo(() => {
    if (!pathname) return "/student/dashboard";
    const exact = studentNavItems.find((item) => item.href === pathname);
    if (exact) return exact.href;
    if (pathname.startsWith("/student/settings") || pathname.startsWith("/account/security")) return "/student/settings";
    return "/student/dashboard";
  }, [pathname]);

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
      setIsSigningOut(false);
      setIsProfileOpen(false);
    }
  }

  return (
    <div className="flex min-h-screen w-full bg-background-soft text-foreground">
      <StudentSidebar
        items={studentNavItems}
        activePath={activePath}
        open={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-brand-200 bg-white/90 px-4 py-3 backdrop-blur sm:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Toggle sidebar"
              onClick={() => setIsSidebarOpen(true)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-brand-200 bg-white text-slate-600 hover:bg-brand-50 lg:hidden"
            >
              <Menu size={18} />
            </button>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-brand-600">Student Portal</p>
              <p className="text-sm font-semibold text-foreground">
                Good day, <span className="font-semibold text-brand-700">{studentName.split(" ")[0]}</span>
              </p>
            </div>
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => setIsProfileOpen((prev) => !prev)}
              className="inline-flex items-center gap-2.5 rounded-xl border border-brand-200 bg-white px-3 py-2 text-sm font-medium text-foreground shadow-soft hover:border-brand-300 hover:bg-brand-50 transition-all"
              aria-haspopup="menu"
              aria-expanded={isProfileOpen}
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-800 text-xs font-bold text-white flex-shrink-0">
                {getInitials(studentName)}
              </span>
              <span className="hidden text-left sm:block">
                <span className="block text-xs text-muted">Student</span>
                <span className="block max-w-[110px] truncate font-semibold text-foreground">{studentName}</span>
              </span>
              <ChevronDown size={14} className="text-muted hidden sm:block" />
            </button>

            {isProfileOpen && (
              <div className="absolute right-0 mt-2 w-72 rounded-2xl border border-brand-200 bg-white p-4 shadow-panel">
                <div className="flex items-center gap-3 pb-3 border-b border-brand-100">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-800 text-base font-bold text-white flex-shrink-0">
                    {getInitials(studentName)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-foreground truncate">{studentName}</p>
                    {studentEmail && <p className="text-xs text-muted truncate">{studentEmail}</p>}
                    {registrationNumber && (
                      <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold text-brand-700">
                        <Hash size={10} />
                        {registrationNumber}
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={handleSignOut}
                    disabled={isSigningOut}
                    className="btn-accent w-full"
                  >
                    <LogOut size={14} />
                    {isSigningOut ? "Logging out…" : "Logout"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 space-y-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-7">{children}</main>
      </div>
    </div>
  );
}
