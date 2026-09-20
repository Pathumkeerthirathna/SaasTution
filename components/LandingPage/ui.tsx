import type { ReactNode } from "react";
import { CheckCircle2 } from "lucide-react";

export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 ${className}`}>{children}</div>;
}

export function Eyebrow({ children, tone = "light" }: { children: ReactNode; tone?: "light" | "dark" }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wider ${
        tone === "dark"
          ? "border-white/15 bg-white/10 text-teal-200"
          : "border-teal-100 bg-teal-50 text-teal-700"
      }`}
    >
      {children}
    </span>
  );
}

export function SectionHead({
  eyebrow,
  title,
  lead,
  tone = "light",
  align = "center",
}: {
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  tone?: "light" | "dark";
  align?: "center" | "left";
}) {
  return (
    <div className={align === "center" ? "mx-auto max-w-3xl text-center" : "max-w-2xl"}>
      <Eyebrow tone={tone}>{eyebrow}</Eyebrow>
      <h2
        className={`mt-4 text-[28px] font-bold leading-[1.15] tracking-tight sm:text-4xl lg:text-[42px] ${
          tone === "dark" ? "text-white" : "text-slate-900"
        }`}
      >
        {title}
      </h2>
      {lead ? (
        <p className={`mt-4 text-[15px] leading-relaxed sm:text-lg ${tone === "dark" ? "text-slate-300" : "text-slate-600"}`}>
          {lead}
        </p>
      ) : null}
    </div>
  );
}

/** Small label on every product screenshot: the data shown is fictional. */
export function SampleTag({ className = "" }: { className?: string }) {
  return (
    <span
      className={`pointer-events-none rounded-full bg-slate-900/75 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-white backdrop-blur ${className}`}
    >
      Sample data
    </span>
  );
}

/** Browser-style window around a product visual. */
export function Frame({
  children,
  title,
  className = "",
  dark = false,
}: {
  children: ReactNode;
  title?: string;
  className?: string;
  dark?: boolean;
}) {
  return (
    <div
      className={`overflow-hidden rounded-2xl border shadow-[0_24px_70px_-24px_rgba(15,23,42,0.45)] ${
        dark ? "border-white/10 bg-[#0B1120]" : "border-slate-200 bg-white"
      } ${className}`}
    >
      <div className={`flex items-center gap-1.5 border-b px-3.5 py-2.5 ${dark ? "border-white/10 bg-white/5" : "border-slate-100 bg-slate-50"}`}>
        <span className="h-2.5 w-2.5 rounded-full bg-rose-300" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
        {title ? <span className={`ml-2 truncate text-[11px] font-medium ${dark ? "text-slate-400" : "text-slate-400"}`}>{title}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function CheckList({
  items,
  tone = "light",
  cols = 1,
}: {
  items: string[];
  tone?: "light" | "dark";
  cols?: 1 | 2;
}) {
  return (
    <ul className={`grid gap-x-6 gap-y-2.5 ${cols === 2 ? "sm:grid-cols-2" : ""}`}>
      {items.map((item) => (
        <li key={item} className={`flex items-start gap-2.5 text-[14.5px] leading-snug ${tone === "dark" ? "text-slate-200" : "text-slate-700"}`}>
          <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${tone === "dark" ? "text-teal-300" : "text-teal-600"}`} />
          {item}
        </li>
      ))}
    </ul>
  );
}
