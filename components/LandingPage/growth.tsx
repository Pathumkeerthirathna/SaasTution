import { CheckCircle2 } from "lucide-react";
import StudentAnalyticsPreview from "./student-analytics-preview";
import SectionHeading from "./section-heading";

const points = [
  "Quiz-based performance tracking",
  "Identify weak students instantly",
  "Share progress with parents",
  "Make data-driven teaching decisions",
];

export default function Growth() {
  return (
    <section className="bg-slate-50 py-12 sm:py-16">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-8 px-4 sm:px-6 lg:grid-cols-2 lg:gap-12 lg:px-8">
        <div className="order-2 lg:order-1">
          <StudentAnalyticsPreview />
        </div>

        <div className="order-1 lg:order-2">
          <SectionHeading
            align="left"
            eyebrow="Insights"
            title="Track student growth — not just attendance"
            description="Monitor how each student performs over time using quiz results and attendance data. Spot improvement or decline and act early."
          />

          <ul className="mt-5 space-y-2.5">
            {points.map((point) => (
              <li key={point} className="flex items-start gap-2.5 text-[13.5px] text-slate-700">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                {point}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
