"use client";

import {
  BookOpen,
  CalendarDays,
  Eye,
  Users,
} from "lucide-react";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

export default function TeacherClassesCard() {
  type ClassItem = {
  id: string;
  name: string;
  monthlyFee: number;
  schedule: string;
  schedules: {
    dayOfWeek: string;
    startTime: string;
    endTime: string;
  }[];
  students: {
    id: string;
    isActive: boolean;
  }[];
};

const [classes, setClasses] = useState<ClassItem[]>([]);
const [loading, setLoading] = useState(true);

const router = useRouter();

useEffect(() => {
  loadClasses();
}, []);

async function loadClasses() {
  try {
    setLoading(true);

    const response = await fetch("/api/classes?page=1&pageSize=100");
    const payload = await response.json();

    if (payload.success) {
      setClasses(payload.data ?? []);
    }
  } finally {
    setLoading(false);
  }
}

const totalStudents = useMemo(
  () =>
    classes.reduce(
      (sum, c) => sum + c.students.filter(s => s.isActive).length,
      0
    ),
  [classes]
);

if (loading) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
      Loading classes...
    </div>
  );
}

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
        <div>
          <h3 className="text-lg font-bold text-slate-900">
            Active Classes
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            Classes currently conducted by the
            teacher.
          </p>
        </div>

        <div className="rounded-xl bg-emerald-50 px-4 py-2">
          <span className="text-sm font-semibold text-emerald-700">
            {classes.length} Active Classes
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="p-6">
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {classes.map((item) => (
            <div
              key={item.id}
              onClick={() => router.push(`/dashboard/publicclasses/${item.id}`)}
              className="group cursor-pointer overflow-hidden rounded-2xl border border-slate-200 bg-white transition-all hover:-translate-y-1 hover:border-emerald-200 hover:shadow-lg"
            >
              {/* Top */}
              <div className="bg-gradient-to-r from-emerald-500 to-emerald-600 p-5 text-white">
                <div className="flex items-center justify-between">
                  <BookOpen className="h-8 w-8 opacity-90" />

                  <span className="rounded-full bg-white/20 px-3 py-1 text-xs font-semibold">
                    Class
                  </span>
                </div>

                <h4 className="mt-4 text-lg font-bold">
                  {item.name}
                </h4>
              </div>

              {/* Details */}
              <div className="space-y-4 p-5">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">
                    Monthly Fee
                  </span>

                  <span className="font-bold text-orange-600">
                    Rs.{" "}
                    {item.monthlyFee.toLocaleString()}
                  </span>
                </div>

                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Users className="h-4 w-4 text-emerald-600" />

                  {item.students.filter(s => s.isActive).length} Students
                </div>

                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <CalendarDays className="h-4 w-4 text-orange-500" />

                  {item.schedule || "Schedule not available"}
                </div>

                <button className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100">
                  <Eye className="h-4 w-4" />
                  View Class
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Summary Section */}
        <div className="mt-6 rounded-2xl border border-orange-100 bg-gradient-to-r from-orange-50 to-emerald-50 p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-500">
                Total Students Across Classes
              </p>

              <h4 className="mt-1 text-2xl font-bold text-slate-900">
                {totalStudents} Students
              </h4>
            </div>

            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-orange-100">
              <Users className="h-7 w-7 text-orange-600" />
            </div>
          </div>

          <p className="mt-4 text-sm leading-6 text-slate-700">
            These classes will be visible on the
            public teacher profile, allowing
            students and parents to discover and
            enroll in available programs.
          </p>
        </div>
      </div>
    </div>
  );
}