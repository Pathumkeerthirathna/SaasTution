"use client";

import { KeyRound } from "lucide-react";

import { AuthShell } from "@/components/auth-shell";
import { AuthIllustration } from "@/components/auth-illustration";
import { ResetConfirmForm } from "@/components/password-reset/reset-confirm-form";

// The token is read once in the browser and removed from the address at
// once (components/password-reset/reset-confirm-form.tsx); this page never
// reads it on the server.
export default function ResetPasswordConfirmPage() {
  return (
    <AuthShell
      title="Set a new password"
      subtitle="Choose a new password for your account, then sign in with it."
      footerText="Remembered it?"
      footerLinkHref="/login"
      footerLinkLabel="Sign in"
      icon={<KeyRound className="h-5 w-5" />}
      illustration={<AuthIllustration />}
      showBackToHome
    >
      <ResetConfirmForm />
    </AuthShell>
  );
}
