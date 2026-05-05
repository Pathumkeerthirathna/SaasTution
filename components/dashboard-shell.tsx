"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useMemo, useState } from "react";
import {
  LayoutDashboard,
  BookOpen,
  Users,
  MessageSquare,
  GraduationCap,
  FolderOpen,
  Settings,
  Radio,
  Shield,
  Menu,
  X,
  LogOut,
  KeyRound,
  ChevronDown,
} from "lucide-react";

type DashboardShellProps = {
  role: "TEACHER" | "ADMIN";
  name: string;
  email: string;
  children: ReactNode;
};

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
};

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
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
      return [{ href: "/dashboard/admin", label: "Admin Overview", icon: <Shield size={16} /> }];
    }
    return [
      { href: "/dashboard",                               label: "Overview",           icon: <LayoutDashboard size={16} /> },
      { href: "/dashboard/classes",                       label: "Classes",            icon: <BookOpen size={16} /> },
      { href: "/dashboard/students",                      label: "Students",           icon: <Users size={16} /> },
      { href: "/dashboard/messages",                      label: "Messages",           icon: <MessageSquare size={16} /> },
      { href: "/dashboard/lectures",                      label: "Lectures",           icon: <GraduationCap size={16} /> },
      { href: "/dashboard/material-bundles",              label: "Tutes & Papers",     icon: <FolderOpen size={16} /> },
      { href: "/dashboard/material-bundles/configuration",label: "Paper Config",       icon: <Settings size={16} /> },
      { href: "/dashboard/sessions",                      label: "Live Sessions",      icon: <Radio size={16} /> },
    ];
  }, [role]);

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
      setIsSigningOut(false);
    }
  }

  return (
    <div className="flex min-h-screen w-full bg-background-soft text-foreground">
      {/* ── Sidebar ── */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-white shadow-panel transition-transform duration-220 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:shadow-none lg:border-r lg:border-brand-200 ${
          isSidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Logo / Brand */}
        <div className="flex items-center justify-between px-5 py-5 border-b border-brand-100">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-700 text-white shadow-soft">
              <GraduationCap size={16} />
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-brand-700">SaasTution</p>
              <p className="text-xs text-muted leading-tight">{role === "ADMIN" ? "Admin Console" : "Teacher Panel"}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsSidebarOpen(false)}
            className="rounded-lg p-1 text-muted hover:bg-brand-50 lg:hidden"
            aria-label="Close sidebar"
          >
            <X size={18} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setIsSidebarOpen(false)}
                className={`nav-item ${isActive ? "nav-item-active" : "nav-item-inactive"}`}
              >
                <span className={`flex h-7 w-7 items-center justify-center rounded-lg flex-shrink-0 transition-colors ${
                  isActive ? "bg-white/20 text-white" : "bg-brand-50 text-brand-600"
                }`}>
                  {item.icon}
                </span>
                <span className="tracking-[0.01em]">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Profile footer */}
        <div className="border-t border-brand-100 px-4 py-4">
          <div className="flex items-center gap-3 rounded-xl p-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-brand-600 to-brand-800 text-xs font-bold text-white flex-shrink-0">
              {getInitials(name)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-foreground">{name}</p>
              <p className="truncate text-xs text-muted">{role}</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Overlay */}
      {isSidebarOpen && (
        <button
          type="button"
          aria-label="Close sidebar"
          className="fixed inset-0 z-30 bg-slate-900/40 backdrop-blur-[2px] lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* ── Main content ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-brand-200 bg-white/90 px-4 py-3 backdrop-blur sm:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsSidebarOpen(true)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-brand-200 bg-white text-slate-600 hover:bg-brand-50 lg:hidden"
              aria-label="Toggle sidebar"
            >
              <Menu size={18} />
            </button>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-brand-600">
                {role === "ADMIN" ? "Admin Console" : "Teacher Workspace"}
              </p>
              <p className="text-sm font-semibold text-foreground">Welcome back, {name.split(" ")[0]}</p>
            </div>
          </div>

          {/* Profile button */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsProfileOpen((prev) => !prev)}
              className="inline-flex items-center gap-2.5 rounded-xl border border-brand-200 bg-white px-3 py-2 text-sm font-medium text-foreground shadow-soft hover:border-brand-300 hover:bg-brand-50 transition-all"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-brand-600 to-brand-800 text-xs font-bold text-white">
                {getInitials(name)}
              </span>
              <span className="hidden sm:block max-w-[120px] truncate">{name}</span>
              <ChevronDown size={14} className="text-muted hidden sm:block" />
            </button>

            {isProfileOpen && (
              <div className="absolute right-0 mt-2 w-72 rounded-2xl border border-brand-200 bg-white p-4 shadow-panel">
                <div className="flex items-center gap-3 pb-3 border-b border-brand-100">
                  <div className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-brand-600 to-brand-800 text-base font-bold text-white flex-shrink-0">
                    {getInitials(name)}
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground truncate">{name}</p>
                    <p className="text-xs text-muted truncate">{email}</p>
                    <span className="mt-1 inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700">
                      {role}
                    </span>
                  </div>
                </div>
                <div className="mt-3 space-y-2">
                  <Link
                    href="/account/security"
                    onClick={() => setIsProfileOpen(false)}
                    className="btn-secondary w-full"
                  >
                    <KeyRound size={14} />
                    Change password
                  </Link>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    disabled={isSigningOut}
                    className="btn-accent w-full"
                  >
                    <LogOut size={14} />
                    {isSigningOut ? "Signing out…" : "Sign out"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-7">{children}</main>
      </div>
    </div>
  );
}

