import { Suspense } from "react";

import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted">Loading login...</div>}>
      <LoginForm />
    </Suspense>
  );
}
