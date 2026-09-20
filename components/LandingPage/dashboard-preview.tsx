import {
  BarChart3,
  CalendarCheck,
  Radio,
  Users,
} from "lucide-react";

const stats = [
  { icon: Users, label: "Students", value: "120", tone: "bg-sky-50 text-sky-600" },
  { icon: CalendarCheck, label: "Attendance", value: "92%", tone: "bg-emerald-50 text-emerald-600" },
  { icon: BarChart3, label: "Avg score", value: "78%", tone: "bg-violet-50 text-violet-600" },
];

const quizzes = [
  { name: "Math Quiz", score: 85, color: "bg-emerald-500", text: "text-emerald-600" },
  { name: "Science Quiz", score: 70, color: "bg-amber-500", text: "text-amber-600" },
  { name: "English Quiz", score: 55, color: "bg-rose-500", text: "text-rose-500" },
];

export default function DashboardPreview() {
  return (
    <div className="w-full overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg">
      {/* Window bar */}
      <div className="flex items-center gap-1.5 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-300" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
        <span className="ml-2 text-[11px] font-medium text-slate-400">
          Teacher dashboard · sample data
        </span>
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-2.5">
          {stats.map(({ icon: Icon, label, value, tone }) => (
            <div key={label} className="rounded-xl border border-slate-100 p-2.5 sm:p-3">
              <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${tone}`}>
                <Icon className="h-3.5 w-3.5" />
              </span>
              <p className="mt-2 text-[11px] text-slate-500">{label}</p>
              <p className="text-base font-bold text-slate-900 sm:text-lg">{value}</p>
            </div>
          ))}
        </div>

        {/* Live class */}
        <div className="flex items-center justify-between gap-3 rounded-xl bg-[#112D5C] px-3.5 py-3 text-white">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10">
              <Radio className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold">Grade 11 Mathematics</p>
              <p className="text-[11px] text-white/70">Live now · 42 students joined</p>
            </div>
          </div>
          <span className="shrink-0 rounded-full bg-rose-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">
            Live
          </span>
        </div>

        {/* Quiz results */}
        <div>
          <p className="mb-2 text-[13px] font-semibold text-slate-800">Recent quiz results</p>

          <div className="space-y-2.5">
            {quizzes.map((quiz) => (
              <div key={quiz.name}>
                <div className="mb-1 flex items-center justify-between text-[12px]">
                  <span className="text-slate-600">{quiz.name}</span>
                  <span className={`font-semibold ${quiz.text}`}>{quiz.score}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full rounded-full ${quiz.color}`} style={{ width: `${quiz.score}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
