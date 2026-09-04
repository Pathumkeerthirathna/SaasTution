"use client";

import Link from "next/link";
import {
  LayoutDashboard,
  BookOpen,
  Radio,
  FolderOpen,
  ClipboardList,
  HelpCircle,
  FileText,
  ScrollText,
  CalendarCheck,
  CalendarDays,
  MessageSquare,
  Settings,
  GraduationCap,
  Wallet,
  X,
  ChevronRight,
  LucideIcon,
} from "lucide-react";

import { SidebarGraduate } from "@/components/sidebar-graduate";

type SidebarItem = {
  href: string;
  label: string;
  icon: string;
};

type StudentSidebarProps = {
  items: SidebarItem[];
  activePath: string;
  open: boolean;
  onClose: () => void;
  onToggle: () => void;
};

const iconMap: Record<string, LucideIcon> = {
  dashboard:   LayoutDashboard,
  calendar:    CalendarDays,
  classes:     BookOpen,
  live:        Radio,
  folder:      FolderOpen,
  assignments: ClipboardList,
  quizzes:     HelpCircle,
  lectures:    FileText,
  papers:      ScrollText,
  attendance:  CalendarCheck,
  messages:    MessageSquare,
  settings:    Settings,
  payments:    Wallet,
};

export function StudentSidebar({ items, activePath, open, onClose, onToggle }: StudentSidebarProps) {
  return (
    <>
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col overflow-hidden bg-gradient-to-b from-emerald-600 via-emerald-700 to-teal-800 text-white shadow-panel transition-[transform,width] duration-220 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:shadow-xl lg:border-r lg:border-white/[0.12] ${
          open ? "translate-x-0 lg:w-64" : "-translate-x-full lg:w-20"
        }`}
      >
        {/* Bottom illustration — sits behind the nav at low contrast */}
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 bottom-0 z-0 select-none opacity-[0.16] [mask-image:linear-gradient(to_bottom,transparent,#000_50%)] ${
            open ? "" : "hidden lg:hidden"
          }`}
        >
          <SidebarGraduate />
        </div>

        {/* Brand header */}
        <div
          className={`relative z-10 flex border-b border-white/[0.12] px-4 py-4 ${
            open
              ? "items-center justify-between gap-2"
              : "items-center justify-between gap-2 lg:flex-col lg:gap-3"
          }`}
        >
          <div className={`flex min-w-0 items-center gap-2.5 ${open ? "" : "lg:justify-center"}`}>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-emerald-700 shadow-sm">
              <GraduationCap size={17} strokeWidth={1.75} />
            </div>
            <div className={open ? "" : "hidden lg:hidden"}>
              <p className="text-[13px] font-semibold tracking-wide text-white/95">SaasTution</p>
              <p className="text-[11px] leading-tight text-white/60">Student Portal</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onToggle}
            className="shrink-0 rounded-lg p-1 text-white/45 hover:bg-white/[0.06] hover:text-white/80"
            aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
          >
            {open ? <X size={18} /> : <ChevronRight size={18} />}
          </button>
        </div>

        {/* Nav items */}
        <nav className="relative z-10 flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
          {items.map((item) => {
            const isActive = activePath === item.href;
            const Icon = iconMap[item.icon] ?? LayoutDashboard;
            return (
              <Link
                key={item.href}
                href={item.href}
                title={!open ? item.label : undefined}
                aria-label={item.label}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] transition-all duration-150 ${
                  isActive
                    ? "bg-white/15 font-medium text-white shadow-sm ring-1 ring-white/10"
                    : "font-normal text-white/75 hover:bg-white/[0.08] hover:text-white"
                } ${open ? "" : "lg:justify-center lg:px-0"}`}
              >
                <span className="flex-shrink-0">
                  <Icon size={18} strokeWidth={1.75} />
                </span>
                <span className={`tracking-[0.005em] ${open ? "" : "hidden lg:hidden"}`}>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      {open && (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-slate-900/40 backdrop-blur-[2px] lg:hidden"
        />
      )}
    </>
  );
}
