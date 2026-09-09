"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

export function GuardianSignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/guardian-auth/logout", { method: "POST" });
    } finally {
      router.push("/guardian/login");
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
    >
      <LogOut className="h-3.5 w-3.5" />
      {busy ? "Signing out..." : "Sign out"}
    </button>
  );
}
