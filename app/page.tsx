import CTA from "@/components/LandingPage/cta";
import Features from "@/components/LandingPage/features";
import Growth from "@/components/LandingPage/growth";
import HowItWorks from "@/components/LandingPage/how-it-works";
import Parents from "@/components/LandingPage/parents";
import Hero from "@/components/Layout/hero";
import Navbar from "@/components/Layout/navbar";
import { SectionCard } from "@/components/section-card";
import Link from "next/link";

export default function Home() {
  return (
    // <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-10 sm:px-6 lg:px-8">
    //   <section className="rounded-3xl border border-black/10 bg-card p-6 shadow-sm dark:border-white/10 sm:p-8">
    //     <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">SaasTution Starter</p>
    //     <h1 className="mt-3 max-w-3xl text-3xl font-semibold leading-tight sm:text-4xl">
    //       Next.js 14 + Prisma + TypeScript foundation ready for production workflows.
    //     </h1>
    //     <p className="mt-4 max-w-2xl text-sm text-muted sm:text-base">
    //       This project is set up with App Router, Tailwind CSS, PostgreSQL-ready Prisma integration,
    //       standardized async API response handling, and shared pagination utilities.
    //     </p>

    //     <div className="mt-6 flex flex-col gap-3 sm:flex-row">
    //       <Link
    //         href="/register"
    //         className="inline-flex items-center justify-center rounded-xl bg-foreground px-4 py-2.5 text-sm font-semibold text-background"
    //       >
    //         Create Teacher Account
    //       </Link>
    //       <Link
    //         href="/login"
    //         className="inline-flex items-center justify-center rounded-xl border border-black/10 px-4 py-2.5 text-sm font-semibold hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
    //       >
    //         Teacher Login
    //       </Link>
    //       <Link
    //         href="/dashboard"
    //         className="inline-flex items-center justify-center rounded-xl border border-black/10 px-4 py-2.5 text-sm font-semibold hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
    //       >
    //         Open Dashboard
    //       </Link>
    //       <Link
    //         href="/guardian/login"
    //         className="inline-flex items-center justify-center rounded-xl border border-black/10 px-4 py-2.5 text-sm font-semibold hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
    //       >
    //         Guardian Portal
    //       </Link>
    //     </div>
    //   </section>

    //   <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
    //     <SectionCard
    //       title="App Router"
    //       description="Route handlers live in app/api with async/await and centralized error handling."
    //     />
    //     <SectionCard
    //       title="Prisma + PostgreSQL"
    //       description="Prisma schema and reusable client are configured under prisma and lib."
    //     />
    //     <SectionCard
    //       title="Pagination Utilities"
    //       description="Parse and normalize page/pageSize query values and generate metadata in one place."
    //     />
    //     <SectionCard
    //       title="Service Layer"
    //       description="API calls and business logic are organized in services for maintainability."
    //     />
    //     <SectionCard
    //       title="Response Shape"
    //       description="Every API response follows a success/error envelope for predictable client handling."
    //     />
    //     <SectionCard
    //       title="Mobile Ready"
    //       description="Layout and cards are built with responsive Tailwind breakpoints by default."
    //     />
    //   </section>
    // </main>


    <main className="bg-white text-gray-900">
      <Navbar />
      <Hero />
      <Features />
      <Parents />
      <Growth />
      <HowItWorks />
      <CTA />
    </main>

  );
}
