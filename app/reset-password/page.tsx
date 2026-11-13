"use client";

import { KeyRound } from "lucide-react";

import { AuthShell } from "@/components/auth-shell";
import { AuthIllustration } from "@/components/auth-illustration";
import { ResetRequestForm } from "@/components/password-reset/reset-request-form";

export default function ResetPasswordRequestPage() {
  return (
    <AuthShell
      title="Reset your password"
      subtitle="Students: enter your registration number. Teachers and guardians: enter your email address. If an account exists, we'll send a reset link to its registered email address."
      footerText="Remembered it?"
      footerLinkHref="/login"
      footerLinkLabel="Sign in"
      icon={<KeyRound className="h-5 w-5" />}
      illustration={<AuthIllustration />}
      showBackToHome
    >
      <ResetRequestForm />
    </AuthShell>
  );
}
