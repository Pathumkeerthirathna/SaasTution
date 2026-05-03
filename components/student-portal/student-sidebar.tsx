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

function NavIcon({ icon }: { icon: string }) {
  return <span className="text-base leading-none">{icon}</span>;
}

export function StudentSidebar({ items, activePath, open, onClose }: StudentSidebarProps) {
  return (
    <>
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-72 border-r border-brand-200 bg-card p-5 shadow-xl transition-transform duration-300 lg:static lg:translate-x-0 lg:shadow-none ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-700">Student Portal</p>
          <h2 className="mt-2 text-xl font-semibold text-slate-900">Learning Dashboard</h2>
          <p className="mt-2 text-sm text-slate-600">Track classes, assignments, and progress.</p>
        </div>

        <nav className="space-y-2">
          {items.map((item) => {
            const isActive = activePath === item.href;

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={`flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-left text-sm font-medium transition ${
                  isActive ? "bg-brand-700 text-white" : "text-slate-700 hover:bg-brand-100 hover:text-brand-700"
                }`}
              >
                <NavIcon icon={item.icon} />
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
          className="fixed inset-0 z-30 bg-slate-900/25 lg:hidden"
        />
      ) : null}
    </>
  );
}
