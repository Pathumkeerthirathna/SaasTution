"use client";

import Link from "next/link";

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

function NavIcon({ icon, active }: { icon: string; active: boolean }) {
  return (
    <span
      className={`inline-flex h-7 w-7 items-center justify-center rounded-lg text-sm leading-none transition-colors ${
        active ? "bg-white/20 text-white" : "bg-brand-50 text-brand-700"
      }`}
      aria-hidden="true"
    >
      {icon}
    </span>
  );
}

export function StudentSidebar({ items, activePath, open, onClose }: StudentSidebarProps) {
  return (
    <>
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-72 border-r border-brand-200/90 bg-card p-6 shadow-panel transition-transform duration-220 lg:static lg:translate-x-0 lg:shadow-none ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-8 border-b border-brand-200/70 pb-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-700">Student Portal</p>
          <h2 className="mt-2 text-xl font-semibold text-slate-900">Learning Dashboard</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">Track classes, assignments, messages, and progress in one place.</p>
        </div>

        <nav className="space-y-1.5">
          {items.map((item) => {
            const isActive = activePath === item.href;

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={`group flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-left text-sm font-medium transition-all duration-180 ${
                  isActive
                    ? "bg-brand-700 text-white shadow-soft"
                    : "text-slate-700 hover:bg-brand-50 hover:text-brand-700"
                }`}
              >
                <NavIcon icon={item.icon} active={isActive} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      {open ? (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-slate-900/30 lg:hidden"
        />
      ) : null}
    </>
  );
}
