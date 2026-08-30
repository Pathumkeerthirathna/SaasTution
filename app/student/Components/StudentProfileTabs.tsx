"use client";

import { useState } from "react";
import {
  BookOpen,
  CalendarCheck,
  CreditCard,
  ClipboardCheck,
  FileText,
  History,
  LayoutDashboard,
  Smartphone,
  Users,
} from "lucide-react";
import { StudentAttendance } from "./StudentAttendance";
import { StudentOverview } from "./StudentOverview";
import { StudentClasses } from "./StudentClasses";
import { StudentGuardians } from "./StudentGuardians";
import { StudentHistory } from "./StudentHistory";
import { StudentPapers } from "./studentPapers";
import { StudentPayments } from "./StudentPayments";
import { StudentQuizzes } from "./StudentQuizzes";
import { StudentDevices } from "./studentdevice";
import type {
  AttendanceAnalytics,
  QuizAnalytics,
} from "@/services/student-service";
import type {
  AttendanceRow,
  DeviceRow,
  GuardianRow,
  PaymentData,
  QuizData,
  StudentClassRow,
} from "@/app/dashboard/students/[id]/page";

interface StudentProfileTabsProps {
  studentId: string;
  classes?: StudentClassRow[] | null;
  guardians?: GuardianRow[] | null;
  attendance?: AttendanceRow[] | null;
  quiz?: QuizData | null;
  payments?: PaymentData | null;
  devices?: DeviceRow[] | null;
  analytics?: AttendanceAnalytics | null;
  quizAnalytics?: QuizAnalytics | null;
  onGuardiansChanged?: () => void;
  onDevicesChanged?: () => void;
}

export function StudentProfileTabs({
  studentId,
  classes = null,
  guardians = null,
  attendance = null,
  quiz = null,
  payments = null,
  devices = null,
  analytics = null,
  quizAnalytics = null,
  onGuardiansChanged,
  onDevicesChanged,
}: StudentProfileTabsProps) {
  const [activeTab, setActiveTab] = useState("overview");

  const tabs = [
    { id: "overview", label: "Overview", icon: LayoutDashboard, count: null },
    { id: "classes", label: "Classes", icon: BookOpen, count: classes ? new Set(classes.map((c) => c.class.id)).size : null },
    { id: "guardians", label: "Guardians", icon: Users, count: guardians?.length ?? null },
    { id: "devices", label: "Devices", icon: Smartphone, count: devices?.length ?? null },
    { id: "attendance", label: "Attendance", icon: CalendarCheck, count: attendance?.length ?? null },
    { id: "payments", label: "Payments", icon: CreditCard, count: payments ? payments.summary.unpaidCount : null },
    { id: "quizzes", label: "Quizzes", icon: ClipboardCheck, count: quiz?.summary?.totalQuizzes ?? null },
    { id: "papers", label: "Papers", icon: FileText, count: null },
    { id: "history", label: "History", icon: History, count: null },
  ];

  return (
    <>
      <div className="mb-4 border-b border-slate-200">
        <div className="flex gap-4 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;

            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`relative flex shrink-0 items-center gap-1.5 border-b-2 px-1 py-2 text-[12px] font-medium transition-colors ${
                  active
                    ? "border-teal-600 text-teal-700"
                    : "border-transparent text-slate-500 hover:text-slate-900"
                }`}
              >
                <Icon size={14} />
                {tab.label}
                {tab.count !== null && tab.count > 0 ? (
                  <span
                    className={`rounded-full px-1.5 py-px text-[10px] font-semibold ${
                      active
                        ? "bg-teal-100 text-teal-700"
                        : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {tab.count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        {activeTab === "overview" && (
          <StudentOverview
            studentId={studentId}
            analytics={analytics}
            quizAnalytics={quizAnalytics}
          />
        )}
        {activeTab === "classes" && (
          <StudentClasses studentId={studentId} data={classes} />
        )}
        {activeTab === "guardians" && (
          <StudentGuardians
            studentId={studentId}
            guardians={guardians}
            onChanged={onGuardiansChanged}
          />
        )}
        {activeTab === "devices" && (
          <StudentDevices
            studentId={studentId}
            data={devices}
            onChanged={onDevicesChanged}
          />
        )}
        {activeTab === "attendance" && (
          <StudentAttendance studentId={studentId} data={attendance} />
        )}
        {activeTab === "payments" && (
          <StudentPayments studentId={studentId} data={payments} />
        )}
        {activeTab === "quizzes" && (
          <StudentQuizzes studentId={studentId} data={quiz} />
        )}
        {activeTab === "papers" && <StudentPapers studentId={studentId} />}
        {activeTab === "history" && <StudentHistory studentId={studentId} />}
      </div>
    </>
  );
}
