import { TrendingDown, TrendingUp } from "lucide-react";

const bars = [40, 60, 55, 70, 65, 80, 78];

const insights = [
  { label: "Improving", value: "+12%", tone: "bg-emerald-50 text-emerald-600" },
  { label: "Average", value: "72%", tone: "bg-amber-50 text-amber-600" },
  { label: "At risk", value: "3", tone: "bg-rose-50 text-rose-500" },
];

export default function StudentAnalyticsPreview() {
  return (
    <div className="w-full rounded-2xl border border-slate-200 bg-white p-4 shadow-lg sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[13.5px] font-semibold text-slate-900">Student performance</h3>
        <span className="text-[11px] text-slate-500">Last 7 days · sample data</span>
      </div>

      <div className="flex h-28 items-end gap-1.5 rounded-xl bg-gradient-to-r from-teal-50 to-sky-50 p-2.5 sm:gap-2">
        {bars.map((height, i) => (
          <div
            key={i}
            className="flex-1 rounded-t bg-teal-500"
            style={{ height: `${height}%` }}
          />
        ))}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2.5 text-center">
        {insights.map(({ label, value, tone }) => (
          <div key={label} className={`rounded-lg p-2 ${tone}`}>
            <p className="text-[11px] text-slate-500">{label}</p>
            <p className="text-sm font-bold">{value}</p>
          </div>
        ))}
      </div>

      <div className="mt-3 space-y-1.5 text-[12.5px]">
        <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
          <span className="truncate text-slate-700">Nimal Perera</span>
          <span className="inline-flex shrink-0 items-center gap-1 text-rose-500">
            <TrendingDown className="h-3.5 w-3.5" /> Declining
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
          <span className="truncate text-slate-700">Kavindu Silva</span>
          <span className="inline-flex shrink-0 items-center gap-1 text-emerald-600">
            <TrendingUp className="h-3.5 w-3.5" /> Improving
          </span>
        </div>
      </div>
    </div>
  );
}
