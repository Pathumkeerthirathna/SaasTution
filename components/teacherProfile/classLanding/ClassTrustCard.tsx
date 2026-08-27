"use client";

import {
  BadgeCheck,
  CalendarClock,
  CreditCard,
  Headphones,
  ShieldCheck,
  Star,
} from "lucide-react";

export default function ClassTrustCard() {
  const items = [
    {
      icon: BadgeCheck,
      title: "Verified Teacher",
      description:
        "Every teacher profile is verified before publishing classes.",
      color: "emerald",
    },
    {
      icon: ShieldCheck,
      title: "Secure Learning Platform",
      description:
        "Your learning progress and personal information are securely protected.",
      color: "orange",
    },
    {
      icon: CalendarClock,
      title: "Lifetime Class Updates",
      description:
        "Receive newly uploaded sessions and lecture notes throughout the class.",
      color: "emerald",
    },
    {
      icon: CreditCard,
      title: "Simple Monthly Payment",
      description:
        "Pay only the monthly class fee with transparent pricing.",
      color: "orange",
    },
    {
      icon: Headphones,
      title: "Teacher Support",
      description:
        "Ask questions and receive guidance whenever you need help.",
      color: "emerald",
    },
  ];

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">

      {/* Header */}
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-3.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100">
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
        </div>

        <div>
          <h2 className="text-[16px] font-bold text-slate-900">
            Learn With Confidence
          </h2>
          <p className="mt-0.5 text-[14px] text-slate-500">
            Trusted by thousands of students.
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="p-5">

        <div className="space-y-3">

          {items.map((item) => {
            const Icon = item.icon;

            const bg =
              item.color === "emerald" ? "bg-emerald-100" : "bg-orange-100";

            const text =
              item.color === "emerald" ? "text-emerald-600" : "text-orange-600";

            return (
              <div key={item.title} className="flex gap-3">
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${bg}`}
                >
                  <Icon className={`h-4 w-4 ${text}`} />
                </div>

                <div>
                  <h3 className="text-[14px] font-semibold text-slate-900">
                    {item.title}
                  </h3>
                  <p className="mt-0.5 text-[13px] leading-5 text-slate-600">
                    {item.description}
                  </p>
                </div>
              </div>
            );
          })}

        </div>

        {/* Bottom */}
        <div className="mt-4 rounded-xl border border-emerald-100 bg-gradient-to-r from-emerald-50 to-orange-50 p-3 text-center">
          <div className="flex items-center justify-center gap-1 text-[18px] font-bold text-slate-900">
            4.9
            <Star className="h-4 w-4 fill-orange-400 text-orange-400" />
          </div>
          <p className="mt-0.5 text-[13px] font-medium text-slate-700">
            Average Student Rating
          </p>
          <p className="mt-1 text-[13px] leading-5 text-slate-600">
            Join hundreds of students already learning through this class.
          </p>
        </div>

      </div>

    </div>
  );
}
