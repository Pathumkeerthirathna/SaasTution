import dynamic from "next/dynamic";
import { Suspense } from "react";

const QrScannerPanel = dynamic(() => import("@/components/attendance/qr-scanner-panel").then((mod) => mod.QrScannerPanel), {
  loading: () => <div className="mt-6 text-sm text-muted">Loading the QR scanner...</div>,
});

/**
 * The teacher's physical QR attendance scanner for one lecture (Stage
 * 5.7b-3d). The dashboard layout and middleware require a signed-in teacher;
 * the register API decides whether this lecture is theirs (404 otherwise)
 * and the scan API checks every scan again, so the id from the URL grants
 * nothing.
 */
export default function LectureQrScannerPage({ params }: { params: { lectureId: string } }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col pb-2">
      <Suspense fallback={<div className="mt-6 text-sm text-muted">Loading the QR scanner...</div>}>
        <QrScannerPanel lectureId={params.lectureId} />
      </Suspense>
    </div>
  );
}
