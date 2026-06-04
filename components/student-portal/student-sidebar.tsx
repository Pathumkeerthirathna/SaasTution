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
  ChevronRight,
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
  onToggle: () => void;
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

export function StudentSidebar({ items, activePath, open, onClose, onToggle }: StudentSidebarProps) {
  return (
    <>
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col overflow-hidden bg-white shadow-panel transition-[transform,width] duration-220 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:shadow-none lg:border-r lg:border-brand-200 ${
          open ? "translate-x-0 lg:w-64" : "-translate-x-full lg:w-20"
        }`}
      >
        {/* Brand header */}
        <div className="flex items-center justify-between border-b border-brand-100 px-4 py-5 lg:px-4">
          <div className={`flex items-center gap-2.5 ${open ? "" : "lg:justify-center"}`}>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-600 to-brand-800 text-white shadow-soft">
              <GraduationCap size={16} />
            </div>
            <div className={open ? "" : "hidden lg:hidden"}>
              <p className="text-[11px] font-bold uppercase tracking-widest text-brand-700">SaasTution</p>
              <p className="text-xs leading-tight text-muted">Student Portal</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onToggle}
            className="rounded-lg p-1 text-muted hover:bg-brand-50"
            aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
          >
            {open ? <X size={18} /> : <ChevronRight size={18} />}
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
                title={!open ? item.label : undefined}
                aria-label={item.label}
                className={`nav-item ${isActive ? "nav-item-active" : "nav-item-inactive"} ${open ? "" : "lg:justify-center lg:px-0"}`}
              >
                <NavIcon iconKey={item.icon} active={isActive} />
                <span className={`tracking-[0.01em] ${open ? "" : "hidden lg:hidden"}`}>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Bottom decoration */}
        <div className={`border-t border-brand-100 px-4 py-4 ${open ? "" : "hidden lg:hidden"}`}>
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
