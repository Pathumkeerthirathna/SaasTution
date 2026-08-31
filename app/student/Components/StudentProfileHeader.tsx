"use client";

import Link from "next/link";
import {
  User,
  Phone,
  Mail,
  ArrowLeft,
  GraduationCap,
  Users,
  BookOpen,
  Settings,
  CalendarCheck,
  ClipboardCheck,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";

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

interface StudentProfileHeaderProps {
  student: Student;
  classesCount?: number | null;
  guardiansCount?: number | null;
  attendancePct?: number | null;
  quizAvg?: number | null;
  paidPercent?: number | null;
  dueAmount?: number | null;
}

export function StudentProfileHeader({
  student,
  classesCount = null,
  guardiansCount = null,
  attendancePct = null,
  quizAvg = null,
  paidPercent = null,
  dueAmount = null,
}: StudentProfileHeaderProps) {
  const [isPasswordPanelOpen, setIsPasswordPanelOpen] = useState(false);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isResettingPassword, setIsResettingPassword] = useState(false);

  function validatePassword(): string | null {
    if (!password.trim()) return "Password is required.";
    if (password !== confirmPassword) return "Passwords do not match.";
    if (password.length < 8) return "Password must be at least 8 characters.";
    if (!/[a-z]/.test(password))
      return "Password must include at least one lowercase letter.";
    if (!/[A-Z]/.test(password))
      return "Password must include at least one uppercase letter.";
    if (!/[0-9]/.test(password))
      return "Password must include at least one number.";
    return null;
  }

  async function handleResetPassword() {
    const validationError = validatePassword();
    if (validationError) {
      toast.error(validationError);
      return;
    }

    try {
      setIsResettingPassword(true);

      const response = await fetch(
        `/api/students/${student.id}/resetpassword`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            password,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok || !result.success) {
        toast.error(result.message ?? "Failed to reset password.");
        return;
      }

      toast.success("Password reset successfully.");

      setPassword("");
      setConfirmPassword("");
      setIsPasswordPanelOpen(false);
    } catch (error) {
      console.error(error);
      toast.error("Failed to reset password.");
    } finally {
      setIsResettingPassword(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 px-4 py-3.5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          {/* Avatar */}
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-teal-600 to-teal-700 shadow-sm">
            <User className="h-4 w-4 text-white" />
          </div>

          {/* Details */}
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold leading-tight tracking-tight text-slate-900">
              {student.name}
            </h1>

            <p className="mt-0.5 text-[11px] font-medium text-slate-500">
              Registration No: {student.registrationNumber ?? "—"}
            </p>

            {/* Contact number */}
            <p className="mt-1.5 inline-flex items-center gap-1.5 text-[12px] font-medium text-slate-700">
              <Phone className="h-3.5 w-3.5 text-teal-600" />
              {student.contact || "—"}
            </p>

            {/* Email under contact number */}
            <p className="mt-0.5 flex items-center gap-1.5 text-[12px] font-medium text-slate-700">
              <Mail className="h-3.5 w-3.5 text-slate-400" />
              <span className="truncate">{student.email || "—"}</span>
            </p>

            {/* Counts + metrics under contact number */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {student.grade?.name ? (
                <HeaderChip
                  icon={<GraduationCap className="h-3 w-3" />}
                  tone="slate"
                >
                  {student.grade.name.replace("_", " ")}
                </HeaderChip>
              ) : null}

              <HeaderChip
                icon={<BookOpen className="h-3 w-3" />}
                tone="teal"
                value={classesCount}
              >
                {(count) => `${count} Classes`}
              </HeaderChip>

              <HeaderChip
                icon={<Users className="h-3 w-3" />}
                tone="slate"
                value={guardiansCount}
              >
                {(count) => `${count} Guardian${count === 1 ? "" : "s"}`}
              </HeaderChip>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-4">
          <RadialStat
            value={attendancePct}
            label="Attendance"
            icon={<CalendarCheck className="h-3 w-3" />}
            tone="blue"
          />

          <RadialStat
            value={quizAvg}
            label="Quiz avg"
            icon={<ClipboardCheck className="h-3 w-3" />}
            tone="amber"
          />

          <div className="flex items-center gap-2">
            <RadialStat
              value={paidPercent}
              label="Paid"
              icon={<Wallet className="h-3 w-3" />}
              tone="teal"
            />

            {dueAmount !== null && dueAmount > 0 ? (
              <span className="inline-flex flex-col rounded-md bg-rose-50 px-2 py-1 text-rose-700">
                <span className="text-[9px] font-semibold uppercase tracking-wide text-rose-400">
                  Due
                </span>
                <span className="text-[12px] font-bold leading-tight">
                  Rs. {dueAmount.toLocaleString()}
                </span>
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-1.5">
            <button
            type="button"
            onClick={() => setIsPasswordPanelOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            <Settings className="h-3.5 w-3.5" />
            Settings
          </button>

          <Link
            href="/dashboard/students"
            className="inline-flex items-center gap-1.5 rounded-md bg-teal-600 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-teal-700"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Link>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setIsPasswordPanelOpen(false)}
        className={`fixed inset-0 z-40 bg-black/40 transition ${
          isPasswordPanelOpen
            ? "visible opacity-100"
            : "invisible opacity-0"
        }`}
      />

      <aside
        className={`drawer-panel transition-transform duration-300 ${
          isPasswordPanelOpen
            ? "translate-x-0"
            : "translate-x-full"
        }`}
      >
        <div className="sticky top-0 z-10 -mx-6 mb-6 border-b border-slate-200 bg-white px-6 py-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">
              Reset Student Password
            </h3>

            <button
              type="button"
              onClick={() => setIsPasswordPanelOpen(false)}
              className="btn-ghost"
            >
              Close
            </button>
          </div>
        </div>

        <div className="space-y-5">
          <div>
            <label className="form-label">
              New Password
            </label>

            <input
              type="password"
              value={password}
              onChange={(e) =>
                setPassword(e.target.value)
              }
              className="control-input"
            />

            <p className="mt-1 text-[11px] text-slate-500">
              At least 8 characters, with one uppercase letter, one lowercase
              letter and a number.
            </p>
          </div>

          <div>
            <label className="form-label">
              Confirm Password
            </label>

            <input
              type="password"
              value={confirmPassword}
              onChange={(e) =>
                setConfirmPassword(e.target.value)
              }
              className="control-input"
            />

            {confirmPassword.length > 0 && confirmPassword !== password && (
              <p className="mt-1 text-[11px] font-medium text-rose-600">
                Passwords do not match.
              </p>
            )}
          </div>

          <button
            type="button"
            disabled={isResettingPassword}
            onClick={handleResetPassword}
            className="btn-primary w-full"
          >
            {isResettingPassword
              ? "Resetting..."
              : "Reset Password"}
          </button>
        </div>
      </aside>
    </div>
  );
}

const CHIP_TONES = {
  slate: "bg-slate-100 text-slate-600",
  teal: "bg-teal-50 text-teal-700",
  blue: "bg-blue-50 text-blue-700",
  amber: "bg-amber-50 text-amber-700",
} as const;

function HeaderChip({
  icon,
  tone,
  value,
  children,
}: {
  icon: React.ReactNode;
  tone: keyof typeof CHIP_TONES;
  value?: number | null;
  children: React.ReactNode | ((value: number) => React.ReactNode);
}) {
  const isPending = typeof children === "function" && (value === null || value === undefined);

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${CHIP_TONES[tone]}`}
    >
      {icon}
      {isPending ? (
        <span className="inline-block h-2.5 w-6 animate-pulse rounded bg-current opacity-30" />
      ) : typeof children === "function" ? (
        children(value as number)
      ) : (
        children
      )}
    </span>
  );
}

const RADIAL_TONES = {
  blue: { track: "#dbeafe", bar: "#2563eb", text: "text-blue-700" },
  amber: { track: "#fef3c7", bar: "#d97706", text: "text-amber-700" },
  teal: { track: "#ccfbf1", bar: "#0d9488", text: "text-teal-700" },
} as const;

function RadialStat({
  value,
  label,
  icon,
  tone,
}: {
  value: number | null;
  label: string;
  icon: React.ReactNode;
  tone: keyof typeof RADIAL_TONES;
}) {
  const size = 46;
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  const pending = value === null || value === undefined;
  const pct = pending ? 0 : Math.max(0, Math.min(100, value));
  const offset = circumference * (1 - pct / 100);

  const colors = RADIAL_TONES[tone];

  return (
    <div className="flex items-center gap-2">
      <div
        className="relative shrink-0"
        style={{ width: size, height: size }}
      >
        <svg
          width={size}
          height={size}
          className="-rotate-90"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={colors.track}
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={colors.bar}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={pending ? circumference : offset}
            className="transition-[stroke-dashoffset] duration-700 ease-out"
          />
        </svg>

        <span
          className={`absolute inset-0 flex items-center justify-center text-[11px] font-bold ${colors.text}`}
        >
          {pending ? "…" : `${pct}%`}
        </span>
      </div>

      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {icon}
        {label}
      </span>
    </div>
  );
}
