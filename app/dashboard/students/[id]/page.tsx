"use client";

import { StudentProfileHeader } from "@/app/student/Components/StudentProfileHeader";
import { StudentProfileTabs } from "@/app/student/Components/StudentProfileTabs";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { UserX } from "lucide-react";

import type {
  AttendanceAnalytics,
  QuizAnalytics,
} from "@/services/student-service";

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: {
    message: string;
    code?: string;
  };
}

interface Student {
  id: string;
  name: string;
  contact: string;
  email: string | null;
  contact01: string | null;
  contact02: string | null;
  registrationNumber: string | null;
  gradeId: number | null;
  status: number;
  teacherId: string;
  createdAt: string;
  actionTakenDate: string | null;
  grade?: { name: string } | null;
  classes?: Array<{ classId: string }>;
  guardians?: Array<{ id: string }>;
}

export interface StudentClassRow {
  id: string;
  isActive: boolean;
  assignedAt: string;
  removedAt?: string | null;
  removeReason?: string | null;
  class: {
    id: string;
    name: string;
    description?: string | null;
    schedule: string;
    monthlyFee: number;
    payments: Array<{
      id: string;
      amount?: number | null;
      status: "CONFIRMED" | "PENDING" | "CLARIFICATION" | "NEEDS_CLARIFICATION";
      classStudentFee?: { year: number; month: number } | null;
    }>;
    studentHistory: Array<{
      id: string;
      action: string;
      actionDate: string;
      reason?: string | null;
    }>;
  };
}

export interface GuardianRow {
  id: string;
  studentId: string;
  name: string;
  relation: string;
  phone: string;
  email: string | null;
  createdAt: string;
}

export interface AttendanceRow {
  classId: string;
  className: string;
  attendedLectures: number;
  totalLectures: number;
  attendancePercentage: number;
}

export interface DeviceRow {
  id: string;
  deviceId: string;
  deviceName: string | null;
  deviceModel: string | null;
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  osVersion: string | null;
  platform: string | null;
  userAgent: string | null;
  lastIpAddress: string | null;
  country: string | null;
  city: string | null;
  status: "PENDING" | "APPROVED" | "BLOCKED";
  firstLoginAt: string;
  lastLoginAt: string | null;
  approvalRequestedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  approvedReason: string | null;
  rejectedReason: string | null;
  approvedByTeacher: { id: string; fullName: string } | null;
  approvalRequestMessage: string | null;
}

export interface QuizData {
  summary: {
    totalQuizzes: number;
    attempted: number;
    missed: number;
    averageScore: number;
  } | null;
  classes: Array<{
    classId: string;
    className: string;
    totalQuizzes: number;
    attempted: number;
    missed: number;
    averageScore: number;
  }>;
}

export interface PaymentFeeRow {
  id: string;
  year: number;
  month: number;
  monthLabel: string;
  finalAmount: number;
  dueDate: string | null;
  paid: boolean;
  payment: {
    id: string;
    amount: number;
    status: string;
    submittedAt: string | null;
    confirmedAt: string | null;
  } | null;
}

export interface PaymentClassBucket {
  classId: string;
  className: string;
  monthlyFee: number;
  paidCount: number;
  unpaidCount: number;
  paidAmount: number;
  unpaidAmount: number;
  totalAmount: number;
  fees: PaymentFeeRow[];
}

export interface PaymentData {
  summary: {
    totalFees: number;
    paidCount: number;
    unpaidCount: number;
    paidAmount: number;
    unpaidAmount: number;
    totalAmount: number;
    paidPercent: number;
  };
  classes: PaymentClassBucket[];
}

const EMPTY_PAYMENTS: PaymentData = {
  summary: {
    totalFees: 0,
    paidCount: 0,
    unpaidCount: 0,
    paidAmount: 0,
    unpaidAmount: 0,
    totalAmount: 0,
    paidPercent: 0,
  },
  classes: [],
};

export default function StudentProfilePage() {
  const params = useParams();
  const studentId = params.id as string;

  const [student, setStudent] = useState<Student | null>(null);
  const [loadingStudent, setLoadingStudent] = useState(true);

  const [classes, setClasses] = useState<StudentClassRow[] | null>(null);
  const [guardians, setGuardians] = useState<GuardianRow[] | null>(null);
  const [attendance, setAttendance] = useState<AttendanceRow[] | null>(null);
  const [quiz, setQuiz] = useState<QuizData | null>(null);
  const [payments, setPayments] = useState<PaymentData | null>(null);
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [analytics, setAnalytics] = useState<AttendanceAnalytics | null>(null);
  const [quizAnalytics, setQuizAnalytics] = useState<QuizAnalytics | null>(null);

  const loadStudent = useCallback(async () => {
    try {
      setLoadingStudent(true);

      const response = await fetch(`/api/student/Profile/${studentId}`);
      const result: ApiResponse<Student> = await response.json();

      if (result.success && result.data) {
        setStudent(result.data);
      }
    } catch (error) {
      console.error("Error loading student:", error);
    } finally {
      setLoadingStudent(false);
    }
  }, [studentId]);

  const loadClasses = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/student/Profile/${studentId}/classes`
      );
      const result: ApiResponse<StudentClassRow[]> = await response.json();

      if (result.success && result.data) {
        setClasses(result.data);
      } else {
        setClasses([]);
      }
    } catch (error) {
      console.error("Error loading classes:", error);
      setClasses([]);
    }
  }, [studentId]);

  const loadGuardians = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/students/${studentId}/guardians`,
        { cache: "no-store" }
      );
      const result: ApiResponse<GuardianRow[]> = await response.json();

      if (result.success && result.data) {
        setGuardians(result.data);
      } else {
        setGuardians([]);
      }
    } catch (error) {
      console.error("Error loading guardians:", error);
      setGuardians([]);
    }
  }, [studentId]);

  const loadAnalytics = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/student/Profile/${studentId}/attendance/analytics?months=6`
      );
      const result: ApiResponse<AttendanceAnalytics> = await response.json();

      if (result.success && result.data) {
        setAnalytics(result.data);
      }
    } catch (error) {
      console.error("Error loading attendance analytics:", error);
    }
  }, [studentId]);

  const loadQuizAnalytics = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/student/Profile/${studentId}/quizzes/analytics?period=3months`
      );
      const result: ApiResponse<QuizAnalytics> = await response.json();

      if (result.success && result.data) {
        setQuizAnalytics(result.data);
      }
    } catch (error) {
      console.error("Error loading quiz analytics:", error);
    }
  }, [studentId]);

  const loadDevices = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/student/Profile/${studentId}/devices`
      );
      const result: ApiResponse<DeviceRow[]> = await response.json();

      setDevices(result.success && result.data ? result.data : []);
    } catch (error) {
      console.error("Error loading devices:", error);
      setDevices([]);
    }
  }, [studentId]);

  const loadAttendance = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/student/Profile/${studentId}/attendance`
      );
      const result: ApiResponse<AttendanceRow[]> = await response.json();

      if (result.success && result.data) {
        setAttendance(result.data);
      } else {
        setAttendance([]);
      }
    } catch (error) {
      console.error("Error loading attendance:", error);
      setAttendance([]);
    }
  }, [studentId]);

  const loadQuizzes = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/student/Profile/${studentId}/quizzes`
      );
      const result: ApiResponse<QuizData> = await response.json();

      if (result.success && result.data) {
        setQuiz(result.data);
      } else {
        setQuiz({ summary: null, classes: [] });
      }
    } catch (error) {
      console.error("Error loading quizzes:", error);
      setQuiz({ summary: null, classes: [] });
    }
  }, [studentId]);

  const loadPayments = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/student/Profile/${studentId}/payments`
      );
      const result: ApiResponse<PaymentData> = await response.json();

      setPayments(
        result.success && result.data ? result.data : EMPTY_PAYMENTS
      );
    } catch (error) {
      console.error("Error loading payments:", error);
      setPayments(EMPTY_PAYMENTS);
    }
  }, [studentId]);

  useEffect(() => {
    if (!studentId) return;
    void loadStudent();
  }, [studentId, loadStudent]);

  // Once the student is loaded, pull the related data in parallel.
  useEffect(() => {
    if (!student) return;

    void loadClasses();
    void loadGuardians();
    void loadAttendance();
    void loadQuizzes();
    void loadPayments();
    void loadDevices();
    void loadAnalytics();
    void loadQuizAnalytics();
  }, [
    student,
    loadClasses,
    loadGuardians,
    loadAttendance,
    loadQuizzes,
    loadPayments,
    loadDevices,
    loadAnalytics,
    loadQuizAnalytics,
  ]);

  const classesCount = useMemo(
    () =>
      classes ? new Set(classes.map((row) => row.class.id)).size : null,
    [classes]
  );

  const guardiansCount = guardians ? guardians.length : null;

  const attendancePct = useMemo(() => {
    if (!attendance) return null;

    const totalLectures = attendance.reduce(
      (sum, row) => sum + row.totalLectures,
      0
    );
    const attendedLectures = attendance.reduce(
      (sum, row) => sum + row.attendedLectures,
      0
    );

    if (totalLectures === 0) return 0;
    return Math.round((attendedLectures / totalLectures) * 100);
  }, [attendance]);

  const quizAvg = useMemo(() => {
    if (!quiz) return null;
    if (!quiz.summary) return 0;
    return Math.round(quiz.summary.averageScore);
  }, [quiz]);

  const paidPercent = payments ? payments.summary.paidPercent : null;
  const dueAmount = payments ? payments.summary.unpaidAmount : null;

  if (loadingStudent) {
    return <StudentProfileSkeleton />;
  }

  if (!student) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
          <UserX className="h-6 w-6 text-slate-400" />
        </div>
        <h2 className="mt-3 text-sm font-semibold text-slate-900">
          Student not found
        </h2>
        <p className="mt-1 text-[12px] text-slate-500">
          This student may have been removed or the link is incorrect.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <StudentProfileHeader
        student={student}
        classesCount={classesCount}
        guardiansCount={guardiansCount}
        attendancePct={attendancePct}
        quizAvg={quizAvg}
        paidPercent={paidPercent}
        dueAmount={dueAmount}
      />

      <StudentProfileTabs
        studentId={studentId}
        classes={classes}
        guardians={guardians}
        attendance={attendance}
        quiz={quiz}
        payments={payments}
        devices={devices}
        analytics={analytics}
        quizAnalytics={quizAnalytics}
        onGuardiansChanged={loadGuardians}
        onDevicesChanged={loadDevices}
      />
    </div>
  );
}

function StudentProfileSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      {/* Header */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-start gap-3 px-4 py-3.5">
          <div className="h-9 w-9 rounded-lg bg-slate-200" />
          <div className="space-y-2">
            <div className="h-4 w-40 rounded bg-slate-200" />
            <div className="h-3 w-28 rounded bg-slate-100" />
            <div className="h-3 w-36 rounded bg-slate-100" />
            <div className="h-3 w-48 rounded bg-slate-100" />
            <div className="flex gap-1.5 pt-1">
              <div className="h-4 w-16 rounded-full bg-slate-100" />
              <div className="h-4 w-16 rounded-full bg-slate-100" />
              <div className="h-4 w-20 rounded-full bg-slate-100" />
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-4 border-b border-slate-200 pb-2">
        {[16, 20, 18, 16, 20, 18].map((w, i) => (
          <div
            key={i}
            className="h-4 rounded bg-slate-100"
            style={{ width: `${w * 4}px` }}
          />
        ))}
      </div>

      {/* Cards */}
      <div className="grid gap-3 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
          >
            <div className="h-16 bg-slate-100" />
            <div className="space-y-2 p-4">
              <div className="grid grid-cols-3 gap-1.5">
                <div className="h-10 rounded-lg bg-slate-100" />
                <div className="h-10 rounded-lg bg-slate-100" />
                <div className="h-10 rounded-lg bg-slate-100" />
              </div>
              <div className="h-14 rounded-lg bg-slate-100" />
              <div className="h-3 w-full rounded bg-slate-100" />
              <div className="h-3 w-2/3 rounded bg-slate-100" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
