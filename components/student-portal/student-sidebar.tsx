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
  CalendarCheck,
  MessageSquare,
  Settings,
  GraduationCap,
  X,
  LucideIcon,
} from "lucide-react";

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
};

const iconMap: Record<string, LucideIcon> = {
  dashboard:   LayoutDashboard,
  classes:     BookOpen,
  live:        Radio,
  folder:      FolderOpen,
  assignments: ClipboardList,
  quizzes:     HelpCircle,
  lectures:    FileText,
  attendance:  CalendarCheck,
  messages:    MessageSquare,
  settings:    Settings,
};

function NavIcon({ iconKey, active }: { iconKey: string; active: boolean }) {
  const Icon = iconMap[iconKey] ?? LayoutDashboard;
  return (
    <span
      className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg transition-colors ${
        active ? "bg-white/20 text-white" : "bg-brand-50 text-brand-600"
      }`}
      aria-hidden="true"
    >
      <Icon size={15} />
    </span>
  );
}

export function StudentSidebar({ items, activePath, open, onClose }: StudentSidebarProps) {
  return (
    <>
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-white shadow-panel transition-transform duration-220 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:shadow-none lg:border-r lg:border-brand-200 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Brand header */}
        <div className="flex items-center justify-between border-b border-brand-100 px-5 py-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-600 to-brand-800 text-white shadow-soft">
              <GraduationCap size={16} />
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-brand-700">SaasTution</p>
              <p className="text-xs leading-tight text-muted">Student Portal</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-muted hover:bg-brand-50 lg:hidden"
            aria-label="Close sidebar"
          >
            <X size={18} />
          </button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {items.map((item) => {
            const isActive = activePath === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={`nav-item ${isActive ? "nav-item-active" : "nav-item-inactive"}`}
              >
                <NavIcon iconKey={item.icon} active={isActive} />
                <span className="tracking-[0.01em]">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Bottom decoration */}
        <div className="border-t border-brand-100 px-4 py-4">
          <p className="text-[11px] text-muted text-center">Student Learning Portal</p>
        </div>
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
