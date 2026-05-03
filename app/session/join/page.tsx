import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { JitsiClassroom } from "@/components/jitsi-classroom";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";

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
    <Suspense fallback={<div className="p-6 text-sm text-muted">Loading classroom...</div>}>
      <JitsiClassroom />
    </Suspense>
  );
}
