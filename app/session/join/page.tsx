import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";


import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import JitsiClassroom from "@/components/Jitsi/JitsiClassroom";

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
