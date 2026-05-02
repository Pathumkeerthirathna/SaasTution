import { Suspense } from "react";

import { JitsiClassroom } from "@/components/jitsi-classroom";

export default function SessionJoinPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted">Loading classroom...</div>}>
      <JitsiClassroom />
    </Suspense>
  );
}
