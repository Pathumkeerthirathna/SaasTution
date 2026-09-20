import { Bell, CalendarClock, CircleDollarSign, FileText, GraduationCap, Radio, Timer } from "lucide-react";

import { Frame, SampleTag } from "./ui";

// The student dashboard is rendered on the server from the database, so this is an
// illustration of its verified sections (live now, countdowns, agenda, notes, payments,
// announcements) and not a screenshot.
export default function StudentIllustration() {
  return (
    <Frame title="SL Classroom · Student dashboard (illustration)" className="relative">
      <div className="space-y-3 bg-gradient-to-br from-slate-50 to-teal-50/60 p-3.5 sm:p-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-600 text-white">
            <GraduationCap className="h-4.5 w-4.5" />
          </span>
          <div className="leading-tight">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-teal-700">Student dashboard</p>
            <p className="text-[15px] font-bold text-slate-900">Welcome back, Maya</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-rose-200 bg-white p-3 shadow-sm">
          <div className="flex items-center gap-2.5">
            <span className="flex h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500" />
            <div className="leading-tight">
              <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-rose-600">
                <Radio className="h-3 w-3" /> Live now
              </p>
              <p className="text-[13px] font-semibold text-slate-900">Mathematics - Grade 11</p>
            </div>
          </div>
          <span className="rounded-lg bg-rose-600 px-3 py-1.5 text-[11.5px] font-semibold text-white">Join class</span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <p className="flex items-center gap-1.5 text-[12px] font-bold text-slate-900">
              <Timer className="h-3.5 w-3.5 text-teal-600" /> Countdowns
            </p>
            <ul className="mt-2 space-y-1.5 text-[12px] text-slate-600">
              <li className="flex justify-between gap-2"><span>Quiz - Graphs</span><span className="font-semibold text-amber-700">closes in 2 days</span></li>
              <li className="flex justify-between gap-2"><span>Paper - Unit test</span><span className="font-semibold text-slate-800">5 days</span></li>
            </ul>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <p className="flex items-center gap-1.5 text-[12px] font-bold text-slate-900">
              <CalendarClock className="h-3.5 w-3.5 text-teal-600" /> This week
            </p>
            <ul className="mt-2 space-y-1.5 text-[12px] text-slate-600">
              <li className="flex justify-between gap-2"><span>Physics - Grade 12</span><span className="font-semibold text-slate-800">Fri 5:30 PM</span></li>
              <li className="flex justify-between gap-2"><span>Homework 7 due</span><span className="font-semibold text-slate-800">Thu</span></li>
            </ul>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <p className="flex items-center gap-1.5 text-[12px] font-bold text-slate-900">
              <FileText className="h-3.5 w-3.5 text-teal-600" /> Study notes
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {["Lecture notes", "Practice set 3", "Formula sheet"].map((n) => (
                <span key={n} className="rounded-full bg-teal-50 px-2 py-1 text-[11px] font-medium text-teal-800">{n}</span>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <p className="flex items-center gap-1.5 text-[12px] font-bold text-slate-900">
              <CircleDollarSign className="h-3.5 w-3.5 text-teal-600" /> Payments
            </p>
            <p className="mt-2 text-[12px] text-slate-600">This month: <span className="font-semibold text-emerald-700">Paid</span></p>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="flex items-center gap-1.5 text-[12px] font-bold text-slate-900">
            <Bell className="h-3.5 w-3.5 text-teal-600" /> Announcements
          </p>
          <p className="mt-1.5 text-[12px] text-slate-600">Revision class starts at 6:00 PM this Monday.</p>
        </div>
      </div>
      <SampleTag className="absolute bottom-2.5 right-2.5" />
    </Frame>
  );
}
