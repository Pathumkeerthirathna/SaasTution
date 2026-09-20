import type { Viewport } from "next";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";


import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import JitsiClassroom from "@/components/Jitsi/JitsiClassroom";

// Scoped to the live classroom only. `viewportFit: cover` lets the layout use
// env(safe-area-inset-*) on notched phones; `interactiveWidget: resizes-content`
// makes Android shrink the layout (instead of covering it) when the keyboard opens.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

type SessionJoinPageProps = {
  searchParams?: {
    invite?: string;
  };
};

export default async function SessionJoinPage({ searchParams }: SessionJoinPageProps) {
  const inviteToken = searchParams?.invite?.trim();

  if (inviteToken) {
    const token = cookies().get(AUTH_COOKIE_NAME)?.value;

    if (!token) {
      redirect(`/login?invite=${encodeURIComponent(inviteToken)}`);
    }

    const session = await verifyAuthToken(token);

    if (!session || session.role !== "STUDENT") {
      redirect(`/login?invite=${encodeURIComponent(inviteToken)}`);
    }
  }

 return (
    <Suspense
      fallback={
        <main className="mx-auto flex w-full max-w-7xl flex-1 items-center justify-center py-20">
          <p className="text-sm text-slate-500">
            Loading classroom...
          </p>
        </main>
      }
    >
      <JitsiClassroom />
    </Suspense>
  );
}
