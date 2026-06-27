"use client";

import {
  Users,
  BookOpen,
  GraduationCap,
  Eye,
} from "lucide-react";

export default function TeacherProfileStats() {
  const stats = [
    {
      title: "Total Students",
      value: "1,520",
      icon: Users,
      bg: "bg-emerald-50",
      border: "border-emerald-100",
      iconBg: "bg-emerald-600",
      text: "text-emerald-700",
    },

    {
      title: "Active Classes",
      value: "12",
      icon: BookOpen,
      bg: "bg-orange-50",
      border: "border-orange-100",
      iconBg: "bg-orange-500",
      text: "text-orange-700",
    },

    {
      title: "Qualifications",
      value: "5",
      icon: GraduationCap,
      bg: "bg-sky-50",
      border: "border-sky-100",
      iconBg: "bg-sky-500",
      text: "text-sky-700",
    },

    {
      title: "Profile Views",
      value: "12,480",
      icon: Eye,
      bg: "bg-violet-50",
      border: "border-violet-100",
      iconBg: "bg-violet-500",
      text: "text-violet-700",
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {stats.map((item) => {
        const Icon = item.icon;

        return (
          <div
            key={item.title}
            className={`rounded-2xl border ${item.border} ${item.bg} p-5 shadow-sm transition hover:shadow-md`}
          >
            <div className="flex items-start justify-between">
              <div>
                <p
                  className={`text-sm font-medium ${item.text}`}
                >
                  {item.title}
                </p>

                <h3 className="mt-3 text-3xl font-bold text-slate-900">
                  {item.value}
                </h3>
              </div>

              <div
                className={`flex h-12 w-12 items-center justify-center rounded-xl text-white ${item.iconBg}`}
              >
                <Icon className="h-6 w-6" />
              </div>
            </div>

            <div className="mt-4 h-1.5 rounded-full bg-white/70">
              <div
                className={`h-1.5 rounded-full ${
                  item.iconBg.replace(
                    "bg-",
                    "bg-"
                  )
                }`}
                style={{
                  width: "70%",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}