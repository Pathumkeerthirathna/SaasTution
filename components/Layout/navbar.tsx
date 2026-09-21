"use client";

import Link from "next/link";
import { Menu, X, GraduationCap } from "lucide-react";
import { useState } from "react";

const links = [
  { href: "#platform", label: "Platform" },
  { href: "#dashboard", label: "Dashboard" },
  { href: "#live", label: "Live Classroom" },
  { href: "#after-class", label: "Learning" },
  { href: "#students", label: "Students" },
  { href: "#security", label: "Security" },
];

export default function Navbar() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-600 shadow-sm">
            <GraduationCap className="h-5 w-5 text-white" />
          </div>

          <div className="leading-tight">
            <span className="block text-[17px] font-bold tracking-tight text-slate-900">
              SL Classroom
            </span>
            <span className="hidden text-[11px] text-slate-500 min-[380px]:block">Learn • Teach • Collaborate</span>
          </div>
        </Link>

        {/* Desktop navigation */}
        <nav className="hidden items-center gap-5 xl:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-[13.5px] font-medium text-slate-600 transition hover:text-emerald-600"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Desktop buttons */}
        <div className="hidden items-center gap-2 xl:flex">
          <Link
            href="/login"
            className="rounded-lg border border-slate-300 px-4 py-2 text-[13px] font-semibold text-slate-700 transition hover:border-emerald-500 hover:text-emerald-600"
          >
            Login
          </Link>

          <Link
            href="/register"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition hover:bg-emerald-700"
          >
            Start Teaching
          </Link>
        </div>
        {/* Compact CTA + menu below the desktop breakpoint */}
        <div className="flex items-center gap-2 xl:hidden">
          <Link
            href="/register"
            className="hidden rounded-lg bg-emerald-600 px-3 py-2 text-[12.5px] font-semibold text-white shadow-sm min-[400px]:inline-block"
          >
            Start Teaching
          </Link>
          <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          className="rounded-lg border border-slate-200 p-2 text-slate-700 xl:hidden"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
        </div>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="max-h-[calc(100dvh-4rem)] overflow-y-auto border-t border-slate-200 bg-white xl:hidden">
          <div className="space-y-1 px-4 py-4 sm:px-6">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="block rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                {link.label}
              </Link>
            ))}

            <div className="grid grid-cols-2 gap-2 pt-3">
              <Link
                href="/login"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-slate-300 py-2.5 text-center text-sm font-semibold text-slate-700"
              >
                Login
              </Link>

              <Link
                href="/register"
                onClick={() => setOpen(false)}
                className="rounded-lg bg-emerald-600 py-2.5 text-center text-sm font-semibold text-white"
              >
                Start Teaching
              </Link>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
