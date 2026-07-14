"use client";

import Link from "next/link";
import { Menu, X, GraduationCap } from "lucide-react";
import { useState } from "react";

export default function Navbar() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-20 max-w-7xl items-center justify-between px-4 lg:px-8">

        {/* Logo */}
        <Link
          href="/"
          className="flex items-center gap-3"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-600 shadow-md">
            <GraduationCap className="h-6 w-6 text-white" />
          </div>

          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              SmartClass
            </h1>

            <p className="text-xs text-slate-500">
              Learn Smarter
            </p>
          </div>
        </Link>

        {/* Desktop Navigation */}
        <nav className="hidden items-center gap-8 lg:flex">
          <Link
            href="#features"
            className="font-medium text-slate-600 transition hover:text-emerald-600"
          >
            Features
          </Link>

          <Link
            href="#teachers"
            className="font-medium text-slate-600 transition hover:text-emerald-600"
          >
            Teachers
          </Link>

          <Link
            href="#classes"
            className="font-medium text-slate-600 transition hover:text-emerald-600"
          >
            Classes
          </Link>

          <Link
            href="#how"
            className="font-medium text-slate-600 transition hover:text-emerald-600"
          >
            How It Works
          </Link>

          <Link
            href="#contact"
            className="font-medium text-slate-600 transition hover:text-emerald-600"
          >
            Contact
          </Link>
        </nav>

        {/* Desktop Buttons */}
        <div className="hidden items-center gap-3 lg:flex">

          <Link
            href="/login"
            className="rounded-xl border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-emerald-500 hover:text-emerald-600"
          >
            Login
          </Link>

          <Link
            href="/register"
            className="rounded-xl bg-gradient-to-r from-emerald-600 to-orange-500 px-6 py-2.5 text-sm font-semibold text-white shadow transition hover:shadow-lg"
          >
            Start Free Trial
          </Link>

        </div>

        {/* Mobile Button */}
        <button
          onClick={() => setOpen(!open)}
          className="rounded-xl border border-slate-200 p-2 lg:hidden"
        >
          {open ? (
            <X className="h-6 w-6" />
          ) : (
            <Menu className="h-6 w-6" />
          )}
        </button>
      </div>

      {/* Mobile Menu */}
      {open && (
        <div className="border-t border-slate-200 bg-white lg:hidden">

          <div className="space-y-2 px-5 py-5">

            <Link
              href="#features"
              className="block rounded-xl px-3 py-3 hover:bg-slate-100"
            >
              Features
            </Link>

            <Link
              href="#teachers"
              className="block rounded-xl px-3 py-3 hover:bg-slate-100"
            >
              Teachers
            </Link>

            <Link
              href="#classes"
              className="block rounded-xl px-3 py-3 hover:bg-slate-100"
            >
              Classes
            </Link>

            <Link
              href="#how"
              className="block rounded-xl px-3 py-3 hover:bg-slate-100"
            >
              How It Works
            </Link>

            <Link
              href="#contact"
              className="block rounded-xl px-3 py-3 hover:bg-slate-100"
            >
              Contact
            </Link>

            <div className="mt-5 flex flex-col gap-3">

              <Link
                href="/login"
                className="rounded-xl border border-slate-300 py-3 text-center font-semibold"
              >
                Login
              </Link>

              <Link
                href="/register"
                className="rounded-xl bg-gradient-to-r from-emerald-600 to-orange-500 py-3 text-center font-semibold text-white"
              >
                Start Free Trial
              </Link>

            </div>

          </div>

        </div>
      )}
    </header>
  );
}