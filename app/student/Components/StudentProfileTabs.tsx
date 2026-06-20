"use client";

import { useState } from "react";
import {
  User,
  BookOpen,
  CalendarCheck,
  CreditCard,
  ClipboardCheck,
  FileText,
  History,
} from "lucide-react";
import { StudentOverview } from "./StudentOverview";
import { StudentAttendance } from "./StudentAttendance";
import { StudentClasses } from "./StudentClasses";
import { StudentHistory } from "./StudentHistory";
import { StudentPapers } from "./studentPapers";
import { StudentPayments } from "./StudentPayments";
import { StudentQuizzes } from "./StudentQuizzes";

export function StudentProfileTabs({
  studentId,
}: {
  studentId: string;
}) {
  const [activeTab, setActiveTab] = useState("overview");

  const tabs = [
    {
      id: "overview",
      label: "Overview",
      icon: User,
    },
    {
      id: "classes",
      label: "Classes",
      icon: BookOpen,
    },
    {
      id: "attendance",
      label: "Attendance",
      icon: CalendarCheck,
    },
    {
      id: "payments",
      label: "Payments",
      icon: CreditCard,
    },
    {
      id: "quizzes",
      label: "Quizzes",
      icon: ClipboardCheck,
    },
    {
      id: "papers",
      label: "Papers",
      icon: FileText,
    },
    {
      id: "history",
      label: "History",
      icon: History,
    },
  ];

  return (
    <>
      <div className="mb-6 border-b border-slate-200">
        <div className="flex gap-6 overflow-x-auto">
            {tabs.map((tab) => {
            const Icon = tab.icon;

            return (
                <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`relative flex items-center gap-2 border-b-2 px-1 py-3 text-sm font-medium transition-colors
                    ${
                    activeTab === tab.id
                        ? "border-blue-600 text-blue-600"
                        : "border-transparent text-slate-500 hover:text-slate-900"
                    }`}
                >
                <Icon size={18} />
                {tab.label}
                </button>
            );
            })}
        </div>
        </div>

      <div>
        {activeTab === "overview" && (
          <StudentOverview student={studentId} />
        )}

        {activeTab === "classes" && (
          <StudentClasses studentId={studentId} />
        )}

        {activeTab === "attendance" && (
          <StudentAttendance studentId={studentId} />
        )}

        {activeTab === "payments" && (
          <StudentPayments studentId={studentId} />
        )}

        {activeTab === "quizzes" && (
          <StudentQuizzes studentId={studentId} />
        )}

        {activeTab === "papers" && (
          <StudentPapers studentId={studentId} />
        )}

        {activeTab === "history" && (
          <StudentHistory studentId={studentId} />
        )}
      </div>
    </>
  );
}