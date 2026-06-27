"use client";

import {
  BadgeCheck,
  CalendarClock,
  CreditCard,
  Headphones,
  Lock,
  ShieldCheck,
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
    <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">

      {/* Header */}

      <div className="bg-gradient-to-r from-orange-500 to-emerald-600 px-6 py-5 text-white">

        <div className="flex items-center gap-3">

          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/20">

            <Lock className="h-6 w-6" />

          </div>

          <div>

            <h2 className="text-xl font-bold">
              Learn With Confidence
            </h2>

            <p className="mt-1 text-sm text-orange-50">
              Trusted by thousands of students.
            </p>

          </div>

        </div>

      </div>

      {/* Body */}

      <div className="p-6">

        <div className="space-y-5">

          {items.map((item) => {
            const Icon = item.icon;

            const bg =
              item.color === "emerald"
                ? "bg-emerald-100"
                : "bg-orange-100";

            const text =
              item.color === "emerald"
                ? "text-emerald-600"
                : "text-orange-600";

            return (
              <div
                key={item.title}
                className="flex gap-4"
              >
                <div
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${bg}`}
                >
                  <Icon
                    className={`h-5 w-5 ${text}`}
                  />
                </div>

                <div>

                  <h3 className="font-semibold text-slate-900">
                    {item.title}
                  </h3>

                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    {item.description}
                  </p>

                </div>

              </div>
            );
          })}

        </div>

        {/* Divider */}

        <div className="my-6 border-t border-slate-200" />

        {/* Bottom */}

        <div className="rounded-2xl bg-gradient-to-r from-emerald-50 to-orange-50 p-5">

          <div className="text-center">

            <div className="text-3xl font-bold text-slate-900">
              4.9 ★
            </div>

            <p className="mt-1 text-sm font-medium text-slate-700">
              Average Student Rating
            </p>

            <p className="mt-3 text-sm leading-6 text-slate-600">
              Join hundreds of students who are
              already learning through this class.
            </p>

          </div>

        </div>

      </div>

    </div>
  );
}