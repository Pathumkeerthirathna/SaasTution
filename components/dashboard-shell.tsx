"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutDashboard,
  BookOpen,
  Users,
  MessageSquare,
  GraduationCap,
  FolderOpen,
  Settings,
  Radio,
  CircleDollarSign,
  CalendarDays,
  Shield,
  Menu,
  X,
  LogOut,
  KeyRound,
  ChevronDown,
  ChevronRight,
  BadgeInfo,
  Bell,
  ScrollText,
  Package,
  Lock,
} from "lucide-react";

import { SidebarGraduate } from "@/components/sidebar-graduate";

type DashboardShellProps = {
  role: "TEACHER" | "ADMIN";
  name: string;
  email: string;
  children: ReactNode;
  isPending?: boolean;
};

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  locked?: boolean;
};

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

export function DashboardShell({
  role,
  name,
  email,
  children,
  isPending = false,
}: DashboardShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isProfileOpen) return;

    function handleClickOutside(event: MouseEvent) {
      if (
        profileMenuRef.current &&
        !profileMenuRef.current.contains(event.target as Node)
      ) {
        setIsProfileOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isProfileOpen]);

  const navItems = useMemo<NavItem[]>(() => {
    if (role === "ADMIN") {
      return [
        { href: "/dashboard/admin", label: "Admin Overview", icon: <Shield size={18} strokeWidth={1.75} /> },
        { href: "/dashboard/admin/teachers", label: "Teachers", icon: <Users size={18} strokeWidth={1.75} /> },
        { href: "/dashboard/admin/packages", label: "Packages", icon: <Package size={18} strokeWidth={1.75} /> },
      ];
    }
    const items: NavItem[] = [
      { href: "/dashboard",                               label: "Overview",           icon: <LayoutDashboard size={18} strokeWidth={1.75} /> },
      { href: "/dashboard/calendar",                      label: "Calendar",           icon: <CalendarDays size={18} strokeWidth={1.75} /> },
      { href: "/dashboard/teacher/profile",               label: "Teacher Profile",    icon: <BadgeInfo size={18} strokeWidth={1.75} /> },
      { href: "/dashboard/students",                      label: "Students",           icon: <Users size={18} strokeWidth={1.75} /> },
      { href: "/dashboard/classes",                       label: "Classes",            icon: <BookOpen size={18} strokeWidth={1.75} /> },
      { href: "/dashboard/payments",                      label: "Payments",           icon: <CircleDollarSign size={18} strokeWidth={1.75} /> },
      { href: "/dashboard/messages",                      label: "Messages",           icon: <MessageSquare size={18} strokeWidth={1.75} /> },
      { href: "/dashboard/lectures",                      label: "Lectures",           icon: <GraduationCap size={18} strokeWidth={1.75} /> },
      { href: "/dashboard/material-bundles",              label: "Tutes & Papers",     icon: <FolderOpen size={18} strokeWidth={1.75} /> },
      { href: "/dashboard/papers",                        label: "Papers",             icon: <ScrollText size={18} strokeWidth={1.75} /> },
      { href: "/dashboard/material-bundles/configuration",label: "Paper Config",       icon: <Settings size={18} strokeWidth={1.75} /> },
      { href: "/dashboard/sessions",                      label: "Live Sessions",      icon: <Radio size={18} strokeWidth={1.75} /> },
    ];

    if (!isPending) return items;

    return items.map((item) =>
      item.href === "/dashboard" ? item : { ...item, locked: true }
    );
  }, [role, isPending]);

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
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col overflow-hidden bg-[#32598A] text-white shadow-panel transition-[transform,width] duration-220 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:shadow-xl lg:border-r lg:border-white/[0.12] ${
          isSidebarOpen ? "translate-x-0 lg:w-64" : "-translate-x-full lg:w-20"
        }`}
      >
        {/* Bottom illustration — sits behind the nav at low contrast */}
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 bottom-0 z-0 select-none opacity-[0.16] [mask-image:linear-gradient(to_bottom,transparent,#000_50%)] ${
            isSidebarOpen ? "" : "hidden lg:hidden"
          }`}
        >
          <SidebarGraduate />
        </div>

        {/* Logo / Brand */}
        <div className="relative z-10 flex items-center justify-between border-b border-white/[0.12] px-4 py-4 lg:px-4">
          <div className={`flex items-center gap-2.5 ${isSidebarOpen ? "" : "lg:justify-center"}`}>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-[#2c5fa0] shadow-sm">
              <GraduationCap size={17} strokeWidth={1.75} />
            </div>
            <div className={isSidebarOpen ? "" : "hidden lg:hidden"}>
              <p className="text-[13px] font-semibold tracking-wide text-white/95">SL Classroom</p>
              <p className="text-[11px] text-white/60 leading-tight">{role === "ADMIN" ? "Admin Console" : "Teacher Panel"}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsSidebarOpen((prev) => !prev)}
            className="rounded-lg p-1 text-white/45 hover:bg-white/[0.06] hover:text-white/80"
            aria-label={isSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            {isSidebarOpen ? <X size={18} /> : <ChevronRight size={18} />}
          </button>
        </div>

        {/* Nav */}
        <nav className="relative z-10 flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
          {navItems.map((item) => {
            const isActive = pathname === item.href;

            if (item.locked) {
              return (
                <div
                  key={item.href}
                  role="link"
                  aria-disabled="true"
                  tabIndex={-1}
                  title={
                    !isSidebarOpen
                      ? item.label
                      : "Unlocks once your account is confirmed"
                  }
                  aria-label={`${item.label} (locked until confirmed)`}
                  className={`flex w-full cursor-not-allowed select-none items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-normal text-white/35 ${
                    isSidebarOpen ? "" : "lg:justify-center lg:px-0"
                  }`}
                >
                  <span className="flex-shrink-0">{item.icon}</span>
                  <span className={`flex-1 tracking-[0.005em] ${isSidebarOpen ? "" : "hidden lg:hidden"}`}>
                    {item.label}
                  </span>
                  <Lock className={`flex-shrink-0 ${isSidebarOpen ? "" : "hidden lg:hidden"}`} size={13} strokeWidth={1.75} />
                </div>
              );
            }

            return (
              <Link
                key={item.href}
                href={item.href}
                title={!isSidebarOpen ? item.label : undefined}
                aria-label={item.label}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] transition-all duration-150 ${
                  isActive
                    ? "bg-white/15 font-medium text-white shadow-sm ring-1 ring-white/10"
                    : "font-normal text-white/75 hover:bg-white/[0.08] hover:text-white"
                } ${isSidebarOpen ? "" : "lg:justify-center lg:px-0"}`}
              >
                <span className="flex-shrink-0">{item.icon}</span>
                <span className={`tracking-[0.005em] ${isSidebarOpen ? "" : "hidden lg:hidden"}`}>{item.label}</span>
              </Link>
            );
          })}
        </nav>
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
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-brand-100 bg-white px-4 py-3 sm:px-6">
          {/* decorative curved sweep, right side — muted blue → white */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
            <svg
              className="absolute right-0 top-0 h-full w-[64%] min-w-[440px]"
              viewBox="0 0 440 96"
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="hdr-sweep" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#8ea6d6" stopOpacity="0" />
                  <stop offset="34%" stopColor="#8ea6d6" stopOpacity="0.28" />
                  <stop offset="68%" stopColor="#ffffff" stopOpacity="0.30" />
                  <stop offset="100%" stopColor="#ffffff" stopOpacity="0.38" />
                </linearGradient>
              </defs>
              <path d="M172 0 C 122 34 98 60 46 96 L 440 96 L 440 0 Z" fill="url(#hdr-sweep)" />
              <path
                d="M188 0 C 138 34 114 60 62 96"
                fill="none"
                stroke="#ffffff"
                strokeOpacity="0.45"
                strokeWidth="1.5"
              />
            </svg>
          </div>

          <div className="relative flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsSidebarOpen((prev) => !prev)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 hover:bg-brand-50 hover:text-brand-700"
              aria-label="Toggle sidebar"
            >
              <Menu size={18} />
            </button>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-brand-600">
                {role === "ADMIN" ? "Admin Console" : "Teacher Workspace"}
              </p>
              <p className="text-base font-semibold text-foreground">
                Welcome back, {name.split(" ")[0]} <span aria-hidden="true">👋</span>
              </p>
            </div>
          </div>

          <div className="relative flex items-center gap-2 sm:gap-3">
            {/* Notifications */}
            <button
              type="button"
              className="relative inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-500 hover:bg-brand-50 hover:text-brand-700"
              aria-label="Notifications"
            >
              <Bell size={18} />
              <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-white" />
            </button>

            {/* Profile button */}
            <div className="relative" ref={profileMenuRef}>
            <button
              type="button"
              onClick={() => setIsProfileOpen((prev) => !prev)}
              className="inline-flex items-center gap-2.5 rounded-xl px-1.5 py-1 text-sm font-medium text-foreground hover:bg-brand-50 transition-colors"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-800 text-xs font-bold text-white">
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
          </div>
        </header>

        <main className="flex-1 px-2 py-1 sm:px-3 sm:py-2 lg:px-3 lg:py-2">{children}</main>
      </div>
    </div>
  );
}

