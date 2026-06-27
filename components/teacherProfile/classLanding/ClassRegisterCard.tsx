"use client";

import {
  CalendarDays,
  CheckCircle2,
  Clock3,
  CreditCard,
  GraduationCap,
  Phone,
  ShieldCheck,
  Users,
} from "lucide-react";

import { RegisterClassInfo } from "../../../types/teacherProfileTypes/RegisterClassInfo";

interface Props {
  classInfo: RegisterClassInfo;
}

export default function ClassRegisterCard({
  classInfo,
}: Props) {
  return (
    <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">

      {/* Header */}

     <div className="relative overflow-hidden bg-gradient-to-r from-emerald-600 via-emerald-600 to-orange-500 px-6 py-5 text-white">

        {/* Decorative Circle */}

        <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-white/10" />
        <div className="absolute -right-3 bottom-3 h-12 w-12 rounded-full bg-white/10" />

        <div className="relative flex items-center justify-between">

          <div>

            <h2 className="mt-2 text-2xl font-bold text-white">
              Join This Class
            </h2>

          </div>

          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/15 backdrop-blur-sm">

            <GraduationCap className="h-7 w-7 text-white" />

          </div>

        </div>

      </div>

      

      {/* Form */}

      <div className="space-y-4 p-6">

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700">
            Student Name
          </label>

          <input
            className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-emerald-500"
            placeholder="Enter your name"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700">
            Mobile Number
          </label>

          <input
            className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-emerald-500"
            placeholder="07XXXXXXXX"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700">
            School
          </label>

          <input
            className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-emerald-500"
            placeholder="Your School"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700">
            Grade
          </label>

          <select className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-emerald-500">
            <option>Select Grade</option>
            <option>Grade 6</option>
            <option>Grade 7</option>
            <option>Grade 8</option>
            <option>Grade 9</option>
            <option>Grade 10</option>
            <option>Grade 11</option>
            <option>Grade 12</option>
            <option>Grade 13</option>
          </select>
        </div>

        {/* Buttons */}

        <button
          className="
            w-full
            rounded-xl
            bg-emerald-600
            py-3.5
            text-sm
            font-semibold
            text-white
            transition
            hover:bg-emerald-700
          "
        >
          Register Now
        </button>

        <button
          className="
            flex
            w-full
            items-center
            justify-center
            gap-2
            rounded-xl
            border
            border-orange-300
            bg-orange-50
            py-3.5
            text-sm
            font-semibold
            text-orange-700
            transition
            hover:bg-orange-100
          "
        >
          <Phone className="h-4 w-4" />
          Contact Teacher
        </button>

      </div>

      {/* Included */}

      {/* <div className="border-t border-slate-200 bg-slate-50 p-6">

        <h3 className="font-semibold text-slate-900">
          Included
        </h3>

        <div className="mt-4 space-y-3">

          {[
            "All Live Classes",
            "Video Recordings",
            "Lecture Notes",
            "Past Papers",
            "Assignments",
            "Teacher Support",
          ].map((item) => (
            <div
              key={item}
              className="flex items-center gap-3"
            >
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />

              <span className="text-sm text-slate-700">
                {item}
              </span>
            </div>
          ))}

        </div>

      </div> */}

      {/* Footer */}

      <div className="border-t border-slate-200 p-5">

        <div className="flex items-center gap-3">

          <ShieldCheck className="h-5 w-5 text-emerald-600" />

          <p className="text-xs leading-5 text-slate-500">
            Your registration details are securely
            protected.
          </p>

        </div>

        {/* <div className="mt-4 flex items-center gap-3">

          <CreditCard className="h-5 w-5 text-orange-500" />

          <p className="text-xs leading-5 text-slate-500">
            Flexible monthly payments with no
            hidden charges.
          </p>

        </div> */}

      </div>

    </div>
  );
}