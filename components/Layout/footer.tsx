import Link from "next/link";
import { GraduationCap } from "lucide-react";

const links = [
  { href: "/pricing", label: "Pricing" },
  { href: "/login", label: "Login" },
  { href: "/register", label: "Register" },
  { href: "/guardian/login", label: "Guardian Login" },
];

// Public policy pages (app/terms, app/privacy, app/refund-policy).
const legalLinks = [
  { href: "/terms", label: "Terms & Conditions" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/refund-policy", label: "Refund & Cancellation Policy" },
];

export default function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-slate-50">
      <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-4 px-4 py-6 text-center sm:flex-row sm:px-6 sm:text-left lg:px-8">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600">
            <GraduationCap className="h-4 w-4 text-white" />
          </span>
          <div className="leading-tight">
            <p className="text-[13.5px] font-bold text-slate-900">SL Classroom</p>
            <p className="text-[11.5px] text-slate-500">
              © {new Date().getFullYear()} All rights reserved.
            </p>
          </div>
        </div>

        <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-[13px] font-medium text-slate-600 transition hover:text-emerald-600"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="border-t border-slate-200">
        <nav
          aria-label="Legal"
          className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-center gap-x-5 gap-y-2 px-4 py-4 sm:justify-start sm:px-6 lg:px-8"
        >
          {legalLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-[12.5px] font-medium text-slate-500 transition hover:text-emerald-600"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
