"use client";

import { useCallback, useEffect, useState } from "react";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  CalendarRange,
  Target,
  CheckCircle2,
  Trophy,
  Repeat2,
  ArrowDownWideNarrow,
} from "lucide-react";

import type {
  AttendanceAnalytics,
  AttendanceAnalyticsMonth,
  AttendanceStatusLabel,
  QuizAnalytics,
  QuizAnalyticsPeriod,
  QuizStatusLabel,
} from "@/services/student-service";

interface StudentOverviewProps {
  studentId: string;
  analytics?: AttendanceAnalytics | null;
  quizAnalytics?: QuizAnalytics | null;
}

const ACCENT = "#0d9488"; // teal-600 — the dashboard's system green
const TARGET_STROKE = "#34d399"; // emerald-400
const GRID = "#e2e8f0"; // slate-200
const AXIS_TEXT = "#94a3b8"; // slate-400

const STATUS_STYLES: Record<
  AttendanceStatusLabel | QuizStatusLabel,
  string
> = {
  Excellent: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  Good: "bg-teal-50 text-teal-700 ring-teal-600/20",
  "At Risk": "bg-amber-50 text-amber-700 ring-amber-600/20",
  Poor: "bg-rose-50 text-rose-700 ring-rose-600/20",
  "Needs Attention": "bg-rose-50 text-rose-700 ring-rose-600/20",
};

function scoreBadge(pct: number) {
  if (pct >= 90) return "bg-emerald-50 text-emerald-700 ring-emerald-600/20";
  if (pct >= 75) return "bg-teal-50 text-teal-700 ring-teal-600/20";
  if (pct >= 60) return "bg-amber-50 text-amber-700 ring-amber-600/20";
  return "bg-rose-50 text-rose-700 ring-rose-600/20";
}

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
  });
}

export function StudentOverview({
  studentId,
  analytics,
  quizAnalytics,
}: StudentOverviewProps) {
  return (
    <div className="space-y-8">
      <AttendanceSection studentId={studentId} analytics={analytics} />
      <QuizSection studentId={studentId} quizAnalytics={quizAnalytics} />
    </div>
  );
}

/* ========================================================================== */
/*  Attendance                                                                 */
/* ========================================================================== */

function AttendanceSection({
  studentId,
  analytics,
}: {
  studentId: string;
  analytics?: AttendanceAnalytics | null;
}) {
  const [months, setMonths] = useState(6);
  const [data, setData] = useState<AttendanceAnalytics | null>(
    analytics ?? null
  );
  const [loading, setLoading] = useState(!analytics);

  useEffect(() => {
    if (months === 6 && analytics) {
      setData(analytics);
      setLoading(false);
    }
  }, [analytics, months]);

  const fetchData = useCallback(
    async (nextMonths: number) => {
      setLoading(true);
      try {
        const response = await fetch(
          `/api/student/Profile/${studentId}/attendance/analytics?months=${nextMonths}`
        );
        const result = await response.json();
        if (result.success) setData(result.data as AttendanceAnalytics);
      } catch (error) {
        console.error("Failed to load attendance analytics:", error);
      } finally {
        setLoading(false);
      }
    },
    [studentId]
  );

  function changeRange(next: number) {
    setMonths(next);
    if (next === 6 && analytics) {
      setData(analytics);
      return;
    }
    void fetchData(next);
  }

  return (
    <section className="space-y-4">
      <SectionHeader
        title="Attendance"
        subtitle="Track attendance and participation over time."
      >
        <RangeSelect
          value={String(months)}
          onChange={(v) => changeRange(Number(v))}
          options={[
            { value: "6", label: "Last 6 months" },
            { value: "12", label: "Last 12 months" },
          ]}
        />
      </SectionHeader>

      {loading && !data ? (
        <CardsSkeleton />
      ) : !data || data.totalClasses === 0 ? (
        <EmptyCard
          title="No attendance data yet"
          hint="Attendance analytics appear once this student joins lecture sessions."
        />
      ) : (
        <>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="grid gap-4 sm:grid-cols-3 sm:divide-x sm:divide-slate-100">
              <div className="sm:pr-4">
                <StatLabel>Attendance Rate</StatLabel>
                <div className="mt-1.5 flex items-baseline gap-2">
                  <BigValue>{data.attendanceRate}%</BigValue>
                  <StatusPill status={data.status} />
                </div>
                <ProgressBar value={data.attendanceRate} />
              </div>

              <div className="sm:px-4">
                <StatLabel>Classes Attended</StatLabel>
                <p className="mt-1.5 text-2xl font-bold leading-none text-slate-900">
                  {data.attended}
                  <span className="text-base font-semibold text-slate-400">
                    {" "}
                    / {data.totalClasses}
                  </span>
                </p>
                <p className="mt-3 text-[11px] text-slate-500">
                  {data.totalClasses - data.attended} missed to date
                </p>
              </div>

              <div className="sm:pl-4">
                <StatLabel>Trend</StatLabel>
                <TrendValue
                  delta={data.trendDelta}
                  direction={data.trendDirection}
                />
                <p className="mt-3 text-[11px] text-slate-500">vs last month</p>
              </div>
            </div>
          </div>

          <ChartCard
            title="Attendance trend"
            subtitle="Monthly attendance percentage"
            legendLabel="Attendance"
            target={data.targetLine}
            loading={loading}
            points={data.monthly.map((m: AttendanceAnalyticsMonth) => ({
              label: m.label,
              value: m.percent,
              isCurrent: m.isCurrent,
              t1: `${m.label} · ${m.percent}%`,
              t2: `${m.attended}/${m.total} lectures`,
            }))}
            footerLabel="Average Attendance Duration"
            footerValue={
              data.averageDuration === null
                ? "—"
                : `${data.averageDuration}%`
            }
          />
        </>
      )}
    </section>
  );
}

/* ========================================================================== */
/*  Quiz performance                                                           */
/* ========================================================================== */

const QUIZ_PERIOD_OPTIONS: Array<{ value: QuizAnalyticsPeriod; label: string }> =
  [
    { value: "month", label: "This Month" },
    { value: "3months", label: "Last 3 Months" },
    { value: "year", label: "This Year" },
  ];

function QuizSection({
  studentId,
  quizAnalytics,
}: {
  studentId: string;
  quizAnalytics?: QuizAnalytics | null;
}) {
  const [period, setPeriod] = useState<QuizAnalyticsPeriod>("3months");
  const [data, setData] = useState<QuizAnalytics | null>(quizAnalytics ?? null);
  const [loading, setLoading] = useState(!quizAnalytics);

  useEffect(() => {
    if (period === "3months" && quizAnalytics) {
      setData(quizAnalytics);
      setLoading(false);
    }
  }, [quizAnalytics, period]);

  const fetchData = useCallback(
    async (next: QuizAnalyticsPeriod) => {
      setLoading(true);
      try {
        const response = await fetch(
          `/api/student/Profile/${studentId}/quizzes/analytics?period=${next}`
        );
        const result = await response.json();
        if (result.success) setData(result.data as QuizAnalytics);
      } catch (error) {
        console.error("Failed to load quiz analytics:", error);
      } finally {
        setLoading(false);
      }
    },
    [studentId]
  );

  function changePeriod(next: QuizAnalyticsPeriod) {
    setPeriod(next);
    if (next === "3months" && quizAnalytics) {
      setData(quizAnalytics);
      return;
    }
    void fetchData(next);
  }

  return (
    <section className="space-y-4">
      <SectionHeader
        title="Quiz Performance"
        subtitle="Track quiz results and learning progress over time."
      >
        <RangeSelect
          value={period}
          onChange={(v) => changePeriod(v as QuizAnalyticsPeriod)}
          options={QUIZ_PERIOD_OPTIONS}
        />
      </SectionHeader>

      {loading && !data ? (
        <CardsSkeleton />
      ) : !data || data.totalQuizzes === 0 ? (
        <EmptyCard
          title="No quiz activity yet"
          hint="Quiz analytics appear once this student submits a quiz."
        />
      ) : (
        <>
          {/* Status + summary */}
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
              <StatLabel>Average Score</StatLabel>
              <div className="mt-1.5 flex items-baseline gap-2">
                <BigValue>{data.averageScore}%</BigValue>
                <StatusPill status={data.status} />
              </div>
              <ProgressBar value={data.averageScore} />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <MiniStat
                icon={<CheckCircle2 size={14} className="text-teal-600" />}
                label="Completed"
                value={`${data.completed} / ${data.totalQuizzes}`}
              />
              <MiniStat
                icon={<Trophy size={14} className="text-orange-500" />}
                label="Best Score"
                value={`${data.bestScore}%`}
              />
              <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  <TrendingUp size={13} className="text-slate-400" />
                  Trend
                </p>
                <TrendValue
                  delta={data.trendDelta}
                  direction={data.trendDirection}
                  compact
                />
              </div>
            </div>
          </div>

          <ChartCard
            title="Quiz performance trend"
            subtitle="Monthly average quiz score"
            legendLabel="Avg score"
            target={data.targetLine}
            loading={loading}
            points={data.monthly.map((m) => ({
              label: m.label,
              value: m.percent,
              isCurrent: m.isCurrent,
              t1: `${m.label} · ${m.percent}%`,
              t2: `${m.count} ${m.count === 1 ? "quiz" : "quizzes"}`,
            }))}
          />

          {/* Recent quizzes */}
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-4 py-3">
              <h3 className="text-[13px] font-semibold text-slate-900">
                Recent quizzes
              </h3>
              <p className="mt-0.5 text-[11px] text-slate-500">
                Latest submissions in this period
              </p>
            </div>

            {data.recent.length === 0 ? (
              <p className="px-4 py-6 text-center text-[12px] text-slate-400">
                No quizzes submitted in this period.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-left">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                      <th className="px-4 py-2 font-semibold">Quiz</th>
                      <th className="px-4 py-2 font-semibold">Score</th>
                      <th className="px-4 py-2 font-semibold">Attempts</th>
                      <th className="px-4 py-2 text-right font-semibold">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {data.recent.map((quiz) => (
                      <tr key={quiz.id}>
                        <td className="px-4 py-2.5 text-[12px] font-medium text-slate-800">
                          {quiz.title}
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${scoreBadge(
                              quiz.scorePercent
                            )}`}
                          >
                            {quiz.scorePercent}%
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-[12px] text-slate-600">
                          {quiz.attempts}
                        </td>
                        <td className="px-4 py-2.5 text-right text-[12px] text-slate-500">
                          {shortDate(quiz.submittedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Additional metrics */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MiniStat
              icon={<Repeat2 size={14} className="text-slate-400" />}
              label="Avg Attempts"
              value={data.averageAttempts.toFixed(1)}
            />
            <MiniStat
              icon={<Trophy size={14} className="text-orange-500" />}
              label="Best Score"
              value={`${data.bestScore}%`}
            />
            <MiniStat
              icon={
                <ArrowDownWideNarrow size={14} className="text-slate-400" />
              }
              label="Lowest Score"
              value={`${data.lowestScore}%`}
            />
            <MiniStat
              icon={<CheckCircle2 size={14} className="text-teal-600" />}
              label="Completed"
              value={`${data.completed} / ${data.totalQuizzes}`}
            />
          </div>
        </>
      )}
    </section>
  );
}

/* ========================================================================== */
/*  Shared building blocks                                                     */
/* ========================================================================== */

function SectionHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
          {title}
        </h2>
        <p className="mt-0.5 text-[12px] text-slate-500">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function RangeSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-600 shadow-sm">
      <CalendarRange size={14} className="text-slate-400" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="cursor-pointer bg-transparent pr-1 outline-none"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
      {children}
    </p>
  );
}

function BigValue({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-2xl font-bold leading-none text-slate-900">
      {children}
    </span>
  );
}

function StatusPill({
  status,
}: {
  status: AttendanceStatusLabel | QuizStatusLabel;
}) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
      <div
        className="h-full rounded-full bg-teal-600 transition-[width] duration-700 ease-out"
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

function TrendValue({
  delta,
  direction,
  compact = false,
}: {
  delta: number;
  direction: "up" | "down" | "flat";
  compact?: boolean;
}) {
  const Icon =
    direction === "up" ? TrendingUp : direction === "down" ? TrendingDown : Minus;
  const color =
    direction === "up"
      ? "text-emerald-600"
      : direction === "down"
      ? "text-rose-600"
      : "text-slate-400";

  return (
    <p
      className={`mt-1.5 flex items-center gap-1 font-bold leading-none ${color} ${
        compact ? "text-lg" : "text-2xl"
      }`}
    >
      <Icon size={compact ? 16 : 20} strokeWidth={2.5} />
      {delta > 0 ? "+" : ""}
      {delta}%
    </p>
  );
}

function MiniStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {icon}
        {label}
      </p>
      <p className="mt-1.5 text-lg font-bold leading-none text-slate-900">
        {value}
      </p>
    </div>
  );
}

function EmptyCard({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
      <Target className="mx-auto mb-2 h-8 w-8 text-slate-300" />
      <h3 className="text-[13px] font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 text-[12px] text-slate-500">{hint}</p>
    </div>
  );
}

function CardsSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2">
              <div className="h-2.5 w-24 rounded bg-slate-100" />
              <div className="h-6 w-20 rounded bg-slate-200" />
              <div className="h-2 w-full rounded bg-slate-100" />
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="h-3 w-32 rounded bg-slate-200" />
        <div className="mt-4 h-[200px] rounded-lg bg-slate-100" />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Line chart                                                                 */
/* -------------------------------------------------------------------------- */

interface ChartPoint {
  label: string;
  value: number;
  isCurrent: boolean;
  t1: string;
  t2: string;
}

function ChartCard({
  title,
  subtitle,
  legendLabel,
  target,
  points,
  loading,
  footerLabel,
  footerValue,
}: {
  title: string;
  subtitle: string;
  legendLabel: string;
  target: number;
  points: ChartPoint[];
  loading: boolean;
  footerLabel?: string;
  footerValue?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-semibold text-slate-900">{title}</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">{subtitle}</p>
        </div>

        <div className="flex items-center gap-3 text-[10px] font-medium text-slate-500">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-teal-600" />
            {legendLabel}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-0 w-4 border-t border-dashed border-emerald-400" />
            Target {target}%
          </span>
        </div>
      </div>

      <div className={`mt-3 ${loading ? "opacity-60" : ""}`}>
        <LineChart points={points} target={target} />
      </div>

      {footerLabel ? (
        <div className="mt-3 flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2">
          <span className="text-[11px] font-medium text-slate-500">
            {footerLabel}
          </span>
          <span className="text-[13px] font-bold text-slate-900">
            {footerValue}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function smoothPath(points: Array<{ x: number; y: number }>) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  let d = `M ${points[0].x} ${points[0].y}`;

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }

  return d;
}

function LineChart({
  points,
  target,
}: {
  points: ChartPoint[];
  target: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const W = 640;
  const H = 240;
  const padL = 34;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const n = points.length;
  const xFor = (i: number) =>
    n <= 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW;
  const yFor = (v: number) => padT + (1 - v / 100) * plotH;

  const coords = points.map((p, i) => ({
    x: xFor(i),
    y: yFor(p.value),
    point: p,
  }));

  const linePath = smoothPath(coords);
  const areaPath = linePath
    ? `${linePath} L ${coords[coords.length - 1].x} ${padT + plotH} L ${
        coords[0].x
      } ${padT + plotH} Z`
    : "";

  const gridValues = [0, 25, 50, 75, 100];

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-[220px] w-full min-w-[440px]"
        role="img"
        aria-label="Monthly trend"
      >
        <defs>
          <linearGradient id="overview-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ACCENT} stopOpacity="0.16" />
            <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridValues.map((v) => (
          <g key={v}>
            <line
              x1={padL}
              x2={W - padR}
              y1={yFor(v)}
              y2={yFor(v)}
              stroke={GRID}
              strokeWidth={1}
            />
            <text
              x={padL - 8}
              y={yFor(v) + 3}
              textAnchor="end"
              fontSize="9"
              fill={AXIS_TEXT}
            >
              {v}
            </text>
          </g>
        ))}

        <line
          x1={padL}
          x2={W - padR}
          y1={yFor(target)}
          y2={yFor(target)}
          stroke={TARGET_STROKE}
          strokeWidth={1.5}
          strokeDasharray="4 4"
        />

        {areaPath ? <path d={areaPath} fill="url(#overview-area)" /> : null}
        {linePath ? (
          <path
            d={linePath}
            fill="none"
            stroke={ACCENT}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}

        {coords.map((c, i) => {
          const active = hover === i;
          return (
            <g key={`${c.point.label}-${i}`}>
              <text
                x={c.x}
                y={H - 10}
                textAnchor="middle"
                fontSize="9"
                fontWeight={c.point.isCurrent ? 700 : 400}
                fill={c.point.isCurrent ? "#0f172a" : AXIS_TEXT}
              >
                {c.point.label}
              </text>

              {c.point.isCurrent ? (
                <circle
                  cx={c.x}
                  cy={c.y}
                  r={6}
                  fill="#fff"
                  stroke={ACCENT}
                  strokeWidth={2.5}
                />
              ) : (
                <circle cx={c.x} cy={c.y} r={active ? 4.5 : 3.5} fill={ACCENT} />
              )}

              <circle
                cx={c.x}
                cy={c.y}
                r={16}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() =>
                  setHover((cur) => (cur === i ? null : cur))
                }
              />
            </g>
          );
        })}

        {hover !== null && coords[hover]
          ? (() => {
              const c = coords[hover];
              const boxW = 108;
              const boxH = 38;
              const bx = Math.min(
                Math.max(c.x - boxW / 2, padL),
                W - padR - boxW
              );
              const above = c.y - boxH - 12 > 0;
              const by = above ? c.y - boxH - 12 : c.y + 12;

              return (
                <g pointerEvents="none">
                  <rect
                    x={bx}
                    y={by}
                    width={boxW}
                    height={boxH}
                    rx={6}
                    fill="#0f172a"
                  />
                  <text
                    x={bx + 10}
                    y={by + 15}
                    fontSize="10"
                    fontWeight={700}
                    fill="#fff"
                  >
                    {c.point.t1}
                  </text>
                  <text x={bx + 10} y={by + 28} fontSize="9" fill="#cbd5e1">
                    {c.point.t2}
                  </text>
                </g>
              );
            })()
          : null}
      </svg>
    </div>
  );
}
