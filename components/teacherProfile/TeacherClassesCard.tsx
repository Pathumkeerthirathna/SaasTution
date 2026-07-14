"use client";

import { TeacherClass } from "@/types/teacherProfileTypes/ClassTeacher";
import {
  BookOpen,
  CalendarDays,
  Eye,
} from "lucide-react";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  isPublic?: boolean;
  classes:TeacherClass[]
}



export default function TeacherClassesCard({
 classes,
 isPublic
}:Props) {



const router = useRouter();

// useEffect(() => {
//   if (!classes) return;

//   let cancelled = false;

//   async function loadClasses() {
//     try {
//       setLoading(true);

//       const response = await fetch(
//         `/api/classes?page=1&pageSize=100&teacherId=${teacherId}`,
//         {
//           cache: "no-store",
//         }
//       );

//       if (!response.ok) {
//         throw new Error(`HTTP ${response.status}`);
//       }

//       const payload = await response.json();

//       if (!cancelled) {
//         setClasses(payload.data ?? []);
//       }
//     } catch (err) {
//       console.error(err);
//     } finally {
//       if (!cancelled) {
//         setLoading(false);
//       }
//     }
//   }

//   loadClasses();

//   return () => {
//     cancelled = true;
//   };
// }, [teacherId]);




// if (loading) {
//   return (
//     <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
//       Loading classes...
//     </div>
//   );
// }


  return (

    

    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}

      {classes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 py-12 text-center text-slate-500">
          No active classes available.
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3 p-6">
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
      )}
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
        {/* <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          
        </div> */}

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