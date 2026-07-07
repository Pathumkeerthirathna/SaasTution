"use client";

import {
  BookOpen,
  CalendarDays,
  Eye,
  Users,
} from "lucide-react";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

interface Props {
  teacherId: string;
  isPublic?: boolean;
}



export default function TeacherClassesCard({
 teacherId,
 isPublic
}:Props) {
  type ClassItem = {
  id: string;
  name: string;
  monthlyFee: number;
  startDate: string;
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

    const response = await fetch(`/api/classes?page=1&pageSize=100&teacherId=${teacherId}`);
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

// if (loading) {
//   return (
//     <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
//       Loading classes...
//     </div>
//   );
// }

if (loading) {
  return (
    <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 shadow-sm animate-pulse">
      <div className="flex flex-col gap-6 lg:flex-row lg:justify-between">

        {/* Left */}
        <div className="flex gap-5">

          {/* Avatar */}
          <div className="h-28 w-28 rounded-full bg-slate-200" />

          {/* Details */}
          <div className="space-y-4">
            <div className="h-8 w-64 rounded bg-slate-200" />
            <div className="h-5 w-48 rounded bg-slate-200" />
            <div className="h-4 w-72 rounded bg-slate-200" />
            <div className="h-4 w-56 rounded bg-slate-200" />

            <div className="flex gap-4">
              <div className="h-4 w-32 rounded bg-slate-200" />
              <div className="h-4 w-32 rounded bg-slate-200" />
            </div>
          </div>
        </div>

        {/* Right */}
        <div className="space-y-4">
          <div className="h-11 w-40 rounded-xl bg-slate-200" />
          <div className="h-4 w-24 rounded bg-slate-200" />

          <div className="flex gap-2">
            <div className="h-8 w-20 rounded-full bg-slate-200" />
            <div className="h-8 w-20 rounded-full bg-slate-200" />
            <div className="h-8 w-20 rounded-full bg-slate-200" />
          </div>
        </div>

      </div>
    </div>
  );
}

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
        {/* Left */}
        <div>
          <h3 className="text-lg font-bold text-slate-900">
            Active Classes
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            Classes currently conducted by the teacher.
          </p>
        </div>

        {/* Right */}
        {!isPublic ? (
          <button
            onClick={() => router.push("/dashboard/classes")}
            className="inline-flex items-center rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:shadow-md hover:from-emerald-700 hover:to-emerald-800"
          >
            Manage Classes
          </button>
        ) : (
          <div className="rounded-xl bg-emerald-50 px-4 py-2">
            <span className="text-sm font-semibold text-emerald-700">
              {classes.length} Active Classes
            </span>
          </div>
        )}

        
      </div>

      {/* Body */}
      <div className="p-6">
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {classes.map((item) => (
            <div
              key={item.id}
              onClick={() =>
                router.push(
                  isPublic
                    ? `/publicClass/${item.id}`
                    : `/dashboard/publicclasses/${item.id}`
                )
              }
              //onClick={() => router.push(`/dashboard/publicclasses/${item.id}`)}
              className="group cursor-pointer overflow-hidden rounded-2xl border border-slate-200 bg-white transition-all hover:-translate-y-1 hover:border-emerald-200 hover:shadow-lg"
            >
              {/* Top */}
             <div className="bg-gradient-to-r from-emerald-500 to-emerald-600 p-5 text-white">

                {/* Top Row */}
                <div className="flex items-center justify-between">
                  <BookOpen className="h-8 w-8 opacity-90" />

                  <span className="rounded-full bg-white/20 px-3 py-1 text-xs font-semibold backdrop-blur-sm">
                    Class
                  </span>
                </div>

                {/* Bottom Row */}
                <div className="mt-5 flex items-end justify-between">

                  {/* Left */}
                  <div className="flex items-center gap-2">

                    {item.startDate &&
                      new Date(item.startDate) > new Date() && (
                        <span className="rounded-full bg-red-500 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white shadow">
                          NEW
                        </span>
                    )}

                    <h4 className="text-lg font-bold tracking-tight">
                      {item.name}
                    </h4>

                  </div>

                  {/* Right */}
                  {item.startDate && (
                    <div className="text-right">
                      <p className="text-[10px] uppercase tracking-wide text-emerald-100">
                        Starts
                      </p>

                      <span className="rounded-full bg-white/20 px-3 py-1 text-xs font-semibold backdrop-blur-sm">
                        {new Date(item.startDate).toLocaleDateString("en-GB", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                      </span>
                    </div>
                  )}

                </div>

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

                {/* <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Users className="h-4 w-4 text-emerald-600" />

                  {item.students.filter(s => s.isActive).length} Students
                </div> */}

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
          {/* <div className="flex items-center justify-between">
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
          </div> */}

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