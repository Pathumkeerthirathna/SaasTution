import {
  BadgeInfo,
  BookOpen,
  CalendarDays,
  CircleDollarSign,
  FolderOpen,
  GraduationCap,
  LayoutDashboard,
  MessageSquare,
  Radio,
  ScrollText,
  Settings,
  Users,
} from "lucide-react";

import { Frame, SampleTag } from "./ui";

// Labels below are the ones used in the real teacher dashboard. The dashboard overview is
// rendered on the server from the database, so this is an illustration (not a screenshot).
const NAV = [
  { label: "Overview", icon: LayoutDashboard, active: true },
  { label: "Calendar", icon: CalendarDays },
  { label: "Teacher Profile", icon: BadgeInfo },
  { label: "Students", icon: Users },
  { label: "Classes", icon: BookOpen },
  { label: "Payments", icon: CircleDollarSign },
  { label: "Messages", icon: MessageSquare },
  { label: "Lectures", icon: GraduationCap },
  { label: "Tutes & Papers", icon: FolderOpen },
  { label: "Papers", icon: ScrollText },
  { label: "Paper Config", icon: Settings },
  { label: "Live Sessions", icon: Radio },
];

const STATS = [
  { label: "Classes", value: "3" },
  { label: "Students", value: "24" },
  { label: "Live now", value: "1" },
  { label: "Today", value: "2" },
  { label: "Unpaid", value: "4" },
];

const WORKLOAD = [
  ["Pending students", "2"],
  ["Device approvals", "1"],
  ["Lectures scheduled", "6"],
  ["Events pending", "3"],
  ["Tutes & Papers to send", "1"],
  ["Online papers to review", "5"],
  ["Assignments to review", "8"],
  ["Payments to confirm", "3"],
];

export default function DashboardIllustration() {
  return (
    <Frame title="SL Classroom · Teacher dashboard (illustration)" className="relative">
      <div className="flex min-h-[420px] bg-slate-50 text-slate-900">
        <aside className="hidden w-44 shrink-0 flex-col gap-0.5 bg-gradient-to-b from-[#33598f] to-[#254a80] p-3 sm:flex">
          <div className="mb-3 flex items-center gap-2 px-1">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-[#254a80]">
              <GraduationCap className="h-4 w-4" />
            </span>
            <span className="leading-tight">
              <span className="block text-[12px] font-bold text-white">SL Classroom</span>
              <span className="block text-[10px] text-white/70">Teacher Panel</span>
            </span>
          </div>
          {NAV.map(({ label, icon: Icon, active }) => (
            <span
              key={label}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium ${
                active ? "bg-white/15 text-white" : "text-white/75"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </span>
          ))}
        </aside>

        <div className="min-w-0 flex-1 p-3 sm:p-4">
          <div className="rounded-2xl bg-gradient-to-br from-[#33598f] to-[#2a4f86] p-4 text-white sm:p-5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-teal-200">Teacher dashboard</p>
            <p className="mt-1 text-lg font-bold sm:text-xl">Welcome back, Ms. Emily Hart</p>
            <div className="mt-4 grid grid-cols-5 gap-1.5 sm:gap-2">
              {STATS.map((stat) => (
                <div key={stat.label} className="rounded-xl bg-white/12 px-1.5 py-2 text-center ring-1 ring-white/15 sm:px-2.5">
                  <p className="text-[8.5px] font-semibold uppercase tracking-wide text-white/75 sm:text-[9.5px]">{stat.label}</p>
                  <p className="mt-0.5 text-base font-bold sm:text-lg">{stat.value}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-[13px] font-bold text-rose-900">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500" />
                1 Live Class in Progress
              </p>
              <span className="rounded-md bg-rose-600 px-2.5 py-1 text-[10px] font-semibold text-white">Manage sessions</span>
            </div>
            <div className="mt-2.5 flex items-center justify-between gap-2 rounded-xl border border-rose-100 bg-white p-2.5">
              <div className="min-w-0">
                <p className="truncate text-[12.5px] font-semibold text-rose-900">Mathematics - Grade 11</p>
                <p className="text-[10.5px] text-slate-500">Quadratic Equations - Revision</p>
              </div>
              <span className="shrink-0 rounded-md bg-rose-600 px-3 py-1.5 text-[11px] font-semibold text-white">Join session</span>
            </div>
          </div>

          <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
            <p className="text-[13px] font-bold">Workload overview</p>
            <p className="text-[10.5px] text-slate-500">Pending vs total across your classes</p>
            <div className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {WORKLOAD.map(([label, value]) => (
                <div key={label} className="rounded-lg border border-slate-100 bg-slate-50 px-2 py-1.5">
                  <p className="text-[9px] font-semibold uppercase leading-tight tracking-wide text-slate-500">{label}</p>
                  <p className="mt-0.5 text-sm font-bold text-slate-900">{value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <SampleTag className="absolute bottom-2.5 left-2.5" />
    </Frame>
  );
}
