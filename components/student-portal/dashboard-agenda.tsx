"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CalendarClock,
  Clock,
  UserRound,
  BookOpenText,
  ClipboardList,
  CheckCircle2,
  AlertTriangle,
  ArrowUpRight,
  ScrollText,
  HelpCircle,
  Award,
} from "lucide-react";

type CalendarEntry = {
  key: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  classId: string;
  className: string;
  teacherName: string;
  scheduled: boolean;
  lecture: { id: string; title: string; status: string } | null;
};

type DueAssignment = {
  id: string;
  title: string;
  dueDate: string;
  lectureId: string;
  lectureTitle: string;
  classId: string;
  className: string;
  submitted: boolean;
};

type AgendaPaper = {
  paperId: string;
  name: string;
  startTime: string;
  endTime: string;
  classId: string;
  className: string;
  submitted: boolean;
  marks: number | null;
};

type AgendaQuiz = {
  id: string;
  title: string;
  startDateTime: string;
  endDateTime: string;
  lectureId: string;
  classId: string;
  className: string;
  attempted: boolean;
};

type Preset = "yesterday" | "today" | "tomorrow" | "week" | "month";

const PRESETS: { value: Preset; label: string }[] = [
  { value: "yesterday", label: "Yesterday" },
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
];

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function computeRange(preset: Preset): { from: string; to: string } {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shift = (base: Date, n: number) => {
    const d = new Date(base);
    d.setDate(d.getDate() + n);
    return d;
  };
  switch (preset) {
    case "today":
      return { from: ymd(day), to: ymd(day) };
    case "tomorrow":
      return { from: ymd(shift(day, 1)), to: ymd(shift(day, 1)) };
    case "yesterday":
      return { from: ymd(shift(day, -1)), to: ymd(shift(day, -1)) };
    case "week": {
      const start = shift(day, -day.getDay());
      return { from: ymd(start), to: ymd(shift(start, 6)) };
    }
    case "month":
      return {
        from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)),
        to: ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
      };
  }
}

function time12(v: string | null) {
  if (!v) return "";
  const [hRaw, mRaw] = v.split(":");
  const h = Number(hRaw);
  if (Number.isNaN(h)) return v;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${(mRaw ?? "00").padStart(2, "0")} ${suffix}`;
}

function parseDay(ymdStr: string) {
  return new Date(`${ymdStr}T12:00:00`);
}

function fmtDay(iso: string) {
  return parseDay(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Chips({ value, onChange }: { value: Preset; onChange: (v: Preset) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {PRESETS.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-lg px-2 py-1 text-[11px] font-semibold transition-colors ${
            value === o.value
              ? "bg-emerald-600 text-white"
              : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function CardShell({
  icon,
  iconClass,
  title,
  preset,
  onPreset,
  children,
}: {
  icon: React.ReactNode;
  iconClass: string;
  title: string;
  preset: Preset;
  onPreset: (v: Preset) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-3xl border border-border bg-white shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-100 bg-gradient-to-r from-emerald-50 to-white px-5 py-3">
        <h2 className="inline-flex items-center gap-1.5 text-sm font-bold text-foreground">
          <span className={iconClass}>{icon}</span>
          {title}
        </h2>
        <Chips value={preset} onChange={onPreset} />
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function Skeletons() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-lg border border-dashed border-slate-200 bg-white/70 p-5 text-center text-xs text-slate-500">
      {text}
    </p>
  );
}

export function DashboardAgenda() {
  const [schedPreset, setSchedPreset] = useState<Preset>("today");
  const [duePreset, setDuePreset] = useState<Preset>("week");
  const [papersPreset, setPapersPreset] = useState<Preset>("week");
  const [quizzesPreset, setQuizzesPreset] = useState<Preset>("week");

  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [assignments, setAssignments] = useState<DueAssignment[]>([]);
  const [papers, setPapers] = useState<AgendaPaper[]>([]);
  const [quizzes, setQuizzes] = useState<AgendaQuiz[]>([]);

  const [schedLoading, setSchedLoading] = useState(true);
  const [dueLoading, setDueLoading] = useState(true);
  const [papersLoading, setPapersLoading] = useState(true);
  const [quizzesLoading, setQuizzesLoading] = useState(true);

  const schedRange = useMemo(() => computeRange(schedPreset), [schedPreset]);
  const dueRange = useMemo(() => computeRange(duePreset), [duePreset]);
  const papersRange = useMemo(() => computeRange(papersPreset), [papersPreset]);
  const quizzesRange = useMemo(() => computeRange(quizzesPreset), [quizzesPreset]);

  const loadSchedule = useCallback(async (from: string, to: string) => {
    setSchedLoading(true);
    try {
      const res = await fetch(`/api/student/dashboard/schedule?from=${from}&to=${to}`, { cache: "no-store" });
      const json = (await res.json()) as { success?: boolean; data?: { entries?: CalendarEntry[] } };
      if (json.success && json.data?.entries) setEntries(json.data.entries);
    } catch {
      /* keep last */
    } finally {
      setSchedLoading(false);
    }
  }, []);

  const loadAssignments = useCallback(async (from: string, to: string) => {
    setDueLoading(true);
    try {
      const res = await fetch(`/api/student/dashboard/assignments-due?from=${from}&to=${to}`, { cache: "no-store" });
      const json = (await res.json()) as { success?: boolean; data?: { assignments?: DueAssignment[] } };
      if (json.success && json.data?.assignments) setAssignments(json.data.assignments);
    } catch {
      /* keep last */
    } finally {
      setDueLoading(false);
    }
  }, []);

  const loadPapers = useCallback(async (from: string, to: string) => {
    setPapersLoading(true);
    try {
      const res = await fetch(`/api/student/dashboard/papers?from=${from}&to=${to}`, { cache: "no-store" });
      const json = (await res.json()) as { success?: boolean; data?: { papers?: AgendaPaper[] } };
      if (json.success && json.data?.papers) setPapers(json.data.papers);
    } catch {
      /* keep last */
    } finally {
      setPapersLoading(false);
    }
  }, []);

  const loadQuizzes = useCallback(async (from: string, to: string) => {
    setQuizzesLoading(true);
    try {
      const res = await fetch(`/api/student/dashboard/quizzes?from=${from}&to=${to}`, { cache: "no-store" });
      const json = (await res.json()) as { success?: boolean; data?: { quizzes?: AgendaQuiz[] } };
      if (json.success && json.data?.quizzes) setQuizzes(json.data.quizzes);
    } catch {
      /* keep last */
    } finally {
      setQuizzesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSchedule(schedRange.from, schedRange.to);
  }, [schedRange.from, schedRange.to, loadSchedule]);
  useEffect(() => {
    void loadAssignments(dueRange.from, dueRange.to);
  }, [dueRange.from, dueRange.to, loadAssignments]);
  useEffect(() => {
    void loadPapers(papersRange.from, papersRange.to);
  }, [papersRange.from, papersRange.to, loadPapers]);
  useEffect(() => {
    void loadQuizzes(quizzesRange.from, quizzesRange.to);
  }, [quizzesRange.from, quizzesRange.to, loadQuizzes]);

  // Realtime: the dashboard SSE stream signals coursework changes.
  useEffect(() => {
    const source = new EventSource("/api/student/live/stream");
    source.addEventListener("counts-stale", () => {
      void loadSchedule(schedRange.from, schedRange.to);
      void loadAssignments(dueRange.from, dueRange.to);
      void loadPapers(papersRange.from, papersRange.to);
      void loadQuizzes(quizzesRange.from, quizzesRange.to);
    });
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    schedRange.from,
    schedRange.to,
    dueRange.from,
    dueRange.to,
    papersRange.from,
    papersRange.to,
    quizzesRange.from,
    quizzesRange.to,
  ]);

  return (
    <section className="grid items-start gap-4 lg:grid-cols-2">
      {/* Left column */}
      <div className="space-y-4">
        <CardShell
          icon={<CalendarClock size={14} className="text-emerald-600" />}
          iconClass=""
          title="Schedule"
          preset={schedPreset}
          onPreset={setSchedPreset}
        >
          {schedLoading ? (
            <Skeletons />
          ) : entries.length === 0 ? (
            <Empty text="No classes scheduled for this range." />
          ) : (
            <ul className="space-y-2">
              {entries.map((e) => {
                const href = e.lecture
                  ? `/student/lectures?classId=${e.classId}&focus=${e.lecture.id}`
                  : `/student/lectures?classId=${e.classId}`;
                return (
                  <li key={e.key}>
                    <Link
                      href={href}
                      className={`flex items-start gap-3 rounded-lg border p-2.5 transition-colors hover:bg-emerald-50/40 ${
                        e.lecture ? "border-emerald-200" : "border-amber-200"
                      }`}
                    >
                      <span
                        className={`flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-lg text-[10px] font-bold ${
                          e.lecture ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
                        }`}
                      >
                        {parseDay(e.date).getDate()}
                        <span className="text-[8px] font-semibold uppercase">
                          {parseDay(e.date).toLocaleDateString(undefined, { month: "short" })}
                        </span>
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-slate-900">{e.className}</p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                          <span className="inline-flex items-center gap-1">
                            <Clock size={10} />
                            {e.startTime ? `${time12(e.startTime)} – ${time12(e.endTime)}` : fmtDay(e.date)}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <UserRound size={10} />
                            {e.teacherName}
                          </span>
                        </p>
                        {e.lecture ? (
                          <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700">
                            <BookOpenText size={10} />
                            {e.lecture.title}
                          </p>
                        ) : (
                          <p className="mt-0.5 inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                            Lecture not added yet
                          </p>
                        )}
                      </div>
                      <ArrowUpRight size={13} className="mt-1 shrink-0 text-slate-300" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardShell>

        <CardShell
          icon={<ScrollText size={14} className="text-violet-600" />}
          iconClass=""
          title="Papers scheduled"
          preset={papersPreset}
          onPreset={setPapersPreset}
        >
          {papersLoading ? (
            <Skeletons />
          ) : papers.length === 0 ? (
            <Empty text="No papers scheduled in this range." />
          ) : (
            <ul className="space-y-2">
              {papers.map((p) => {
                const upcoming = new Date(p.startTime).getTime() > Date.now();
                return (
                  <li key={p.paperId}>
                    <Link
                      href={`/student/papers?classId=${p.classId}`}
                      className={`flex items-start gap-3 rounded-lg border p-2.5 transition-colors hover:bg-violet-50/40 ${
                        p.submitted ? "border-emerald-200" : "border-violet-200"
                      }`}
                    >
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                          p.submitted ? "bg-emerald-100 text-emerald-700" : "bg-violet-100 text-violet-700"
                        }`}
                      >
                        {p.submitted ? <CheckCircle2 size={15} /> : <ScrollText size={15} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-slate-900">{p.name}</p>
                        <p className="mt-0.5 truncate text-[11px] text-slate-500">{p.className}</p>
                        <p className="mt-0.5 inline-flex flex-wrap items-center gap-1 text-[11px] font-medium">
                          <CalendarClock size={10} className="text-slate-400" />
                          <span className="text-slate-500">
                            {upcoming ? "Starts" : "Started"} {fmtDateTime(p.startTime)}
                          </span>
                          {p.marks != null ? (
                            <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-700">
                              <Award size={9} /> {p.marks}
                            </span>
                          ) : p.submitted ? (
                            <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-700">
                              Submitted
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <ArrowUpRight size={13} className="mt-1 shrink-0 text-slate-300" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardShell>
      </div>

      {/* Right column */}
      <div className="space-y-4">
        <CardShell
          icon={<ClipboardList size={14} className="text-sky-600" />}
          iconClass=""
          title="Assignments due"
          preset={duePreset}
          onPreset={setDuePreset}
        >
          {dueLoading ? (
            <Skeletons />
          ) : assignments.length === 0 ? (
            <Empty text="Nothing due in this range." />
          ) : (
            <ul className="space-y-2">
              {assignments.map((a) => {
                const overdue = !a.submitted && new Date(a.dueDate).getTime() < Date.now();
                return (
                  <li key={a.id}>
                    <Link
                      href={`/student/assignments?classId=${a.classId}&lectureId=${a.lectureId}&due=1`}
                      className={`flex items-start gap-3 rounded-lg border p-2.5 transition-colors hover:bg-sky-50/40 ${
                        a.submitted ? "border-emerald-200" : overdue ? "border-rose-200" : "border-slate-200"
                      }`}
                    >
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                          a.submitted
                            ? "bg-emerald-100 text-emerald-700"
                            : overdue
                              ? "bg-rose-100 text-rose-700"
                              : "bg-sky-100 text-sky-700"
                        }`}
                      >
                        {a.submitted ? <CheckCircle2 size={15} /> : <ClipboardList size={15} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-slate-900">{a.title}</p>
                        <p className="mt-0.5 truncate text-[11px] text-slate-500">
                          {a.className} · {a.lectureTitle}
                        </p>
                        <p className="mt-0.5 inline-flex flex-wrap items-center gap-1 text-[11px] font-medium">
                          <CalendarClock size={10} className="text-slate-400" />
                          <span className="text-slate-500">Due {fmtDateTime(a.dueDate)}</span>
                          {a.submitted ? (
                            <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-700">
                              Submitted
                            </span>
                          ) : overdue ? (
                            <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-rose-700">
                              <AlertTriangle size={9} /> Overdue
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <ArrowUpRight size={13} className="mt-1 shrink-0 text-slate-300" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardShell>

        <CardShell
          icon={<HelpCircle size={14} className="text-indigo-600" />}
          iconClass=""
          title="Quizzes scheduled"
          preset={quizzesPreset}
          onPreset={setQuizzesPreset}
        >
          {quizzesLoading ? (
            <Skeletons />
          ) : quizzes.length === 0 ? (
            <Empty text="No quizzes scheduled in this range." />
          ) : (
            <ul className="space-y-2">
              {quizzes.map((q) => {
                const now = Date.now();
                const start = new Date(q.startDateTime).getTime();
                const end = new Date(q.endDateTime).getTime();
                const phase = now < start ? "upcoming" : now > end ? "closed" : "open";
                const missed = !q.attempted && phase === "closed";
                return (
                  <li key={q.id}>
                    <Link
                      href={`/student/quizzes?classId=${q.classId}&lectureId=${q.lectureId}&todo=1`}
                      className={`flex items-start gap-3 rounded-lg border p-2.5 transition-colors hover:bg-indigo-50/40 ${
                        q.attempted ? "border-emerald-200" : missed ? "border-rose-200" : "border-indigo-200"
                      }`}
                    >
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                          q.attempted
                            ? "bg-emerald-100 text-emerald-700"
                            : missed
                              ? "bg-rose-100 text-rose-700"
                              : "bg-indigo-100 text-indigo-700"
                        }`}
                      >
                        {q.attempted ? <CheckCircle2 size={15} /> : <HelpCircle size={15} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-slate-900">{q.title}</p>
                        <p className="mt-0.5 truncate text-[11px] text-slate-500">{q.className}</p>
                        <p className="mt-0.5 inline-flex flex-wrap items-center gap-1 text-[11px] font-medium">
                          <CalendarClock size={10} className="text-slate-400" />
                          <span className="text-slate-500">
                            {phase === "upcoming" ? "Opens" : "Opened"} {fmtDateTime(q.startDateTime)}
                          </span>
                          {q.attempted ? (
                            <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-700">
                              Attempted
                            </span>
                          ) : phase === "open" ? (
                            <span className="ml-1 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-sky-700">
                              Open now
                            </span>
                          ) : missed ? (
                            <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-rose-700">
                              <AlertTriangle size={9} /> Missed
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <ArrowUpRight size={13} className="mt-1 shrink-0 text-slate-300" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardShell>
      </div>
    </section>
  );
}
