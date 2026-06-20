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
} from "lucide-react";
import { useState } from "react";

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
}

export function StudentProfileHeader({
  student,
}: StudentProfileHeaderProps) {

  const [isPasswordPanelOpen, setIsPasswordPanelOpen] = useState(false);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isResettingPassword, setIsResettingPassword] = useState(false);

  async function handleResetPassword() {
    if (!password.trim()) {
      alert("Password is required.");
      return;
    }

    if (password !== confirmPassword) {
      alert("Passwords do not match.");
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

      if (!result.success) {
        alert(result.message);
        return;
      }

      alert("Password reset successfully.");

      setPassword("");
      setConfirmPassword("");
      setIsPasswordPanelOpen(false);
    } catch (error) {
      console.error(error);
      alert("Failed to reset password.");
    } finally {
      setIsResettingPassword(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Accent Bar */}
      <div className="h-1.5 bg-gradient-to-r from-blue-600 via-indigo-500 to-violet-500" />

      {/* Header */}
      <div className="flex flex-col gap-5 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-4">
          {/* Avatar */}
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 shadow-sm">
            <User className="h-7 w-7 text-white" />
          </div>

          {/* Details */}
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              {student.name}
            </h1>

            <p className="mt-0.5 text-sm font-medium text-slate-500">
              Registration No: {student.registrationNumber}
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
                <GraduationCap className="h-3.5 w-3.5" />
                {student.grade?.name?.replace("_", " ")}
              </span>

              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
                <BookOpen className="h-3.5 w-3.5" />
                {student.classes?.length ?? 0} Classes
              </span>

              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
                <Users className="h-3.5 w-3.5" />
                {student.guardians?.length ?? 0} Guardian(s)
              </span>
            </div>
          </div>
        </div>

        {/* Back Button */}
        {/* <Link
          href="/dashboard/students"
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link> */}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsPasswordPanelOpen(true)}
            className="
              inline-flex
              items-center
              gap-2
              rounded-lg
              border
              border-slate-200
              bg-white
              px-3.5
              py-2
              text-sm
              font-medium
              text-slate-700
              transition
              hover:bg-slate-50
            "
          >
            <Settings className="h-4 w-4" />
            Settings
          </button>

          <Link
            href="/dashboard/students"
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </div>

      </div>

      

      {/* Contact Section */}
      <div className="grid border-t border-slate-200 md:grid-cols-2">
        {/* Phone */}
        <div className="flex items-center gap-4 p-5 md:border-r md:border-slate-200">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-50">
            <Phone className="h-5 w-5 text-blue-600" />
          </div>

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Contact Number
            </p>

            <p className="mt-1 text-base font-medium text-slate-900">
              {student.contact}
            </p>
          </div>
        </div>

        {/* Email */}
        <div className="flex items-center gap-4 p-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-violet-50">
            <Mail className="h-5 w-5 text-violet-600" />
          </div>

          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Email Address
            </p>

            <p className="mt-1 truncate text-base font-medium text-slate-900">
              {student.email}
            </p>
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