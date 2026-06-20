import {
  BookOpen,
  Calendar,
  ChevronRight,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";

interface ClassPaymentRecord {
  id: string;
  month: string;
  status: "CONFIRMED" | "PENDING" | "CLARIFICATION";
}

interface ClassHistoryRecord {
  id: string;
  action: string;
  actionDate: string;
  reason?: string;
}

interface ClassInfo {
  name: string;
  description?: string;
  schedule: string;
  monthlyFee: number;
  payments: ClassPaymentRecord[];
  studentHistory: ClassHistoryRecord[];
}

interface StudentClass {
  id: string;
  isActive: boolean;
  assignedAt: string;
  class: ClassInfo;
}

interface StudentClassesProps {
  studentId: string;
}

export function StudentClasses({
  studentId,
}: StudentClassesProps) {

  //Code

  const [classes, setClasses] = useState<StudentClass[]>([]);
  const [loading, setLoading] = useState(true);

  const loadClasses = useCallback(async () => {
    if (!studentId) return;

    try {
      setLoading(true);

       const [ classesResponse] = await Promise.all([
        fetch(`/api/student/Profile/${studentId}/classes`)
      ]);

      const result = await classesResponse.json();

      console.log(result.data);

      if (result.success) {
        setClasses(result.data);
      }
    } catch (error) {
      console.error("Failed to load classes:", error);
    } finally {
      setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    loadClasses();
  }, [loadClasses]);

  //End code

  if (loading) {
    return (
      <div className="space-y-5">
        {[1, 2, 3].map((item) => (
          <div
            key={item}
            className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
          >
            <div className="animate-pulse">
              <div className="border-b border-slate-100 p-6">
                <div className="h-5 w-48 rounded bg-slate-200"></div>
                <div className="mt-3 h-4 w-72 rounded bg-slate-100"></div>
              </div>

              <div className="grid gap-4 p-6 md:grid-cols-3">
                <div>
                  <div className="h-3 w-20 rounded bg-slate-200"></div>
                  <div className="mt-2 h-4 w-32 rounded bg-slate-100"></div>
                </div>

                <div>
                  <div className="h-3 w-20 rounded bg-slate-200"></div>
                  <div className="mt-2 h-4 w-24 rounded bg-slate-100"></div>
                </div>

                <div>
                  <div className="h-3 w-20 rounded bg-slate-200"></div>
                  <div className="mt-2 h-4 w-28 rounded bg-slate-100"></div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!loading && classes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
        <BookOpen className="mx-auto mb-3 h-10 w-10 text-slate-400" />
        <h3 className="text-sm font-medium text-slate-900">
          No classes assigned
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          This student has not been assigned to any classes yet.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">

      {classes.map((item: StudentClass) => (
        <div
          key={item.id}
          className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md"
        >
          {/* Header */}
          <div className="border-b border-slate-100 bg-slate-50 px-6 py-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
                  <BookOpen className="h-5 w-5 text-blue-600" />
                  {item.class.name}
                </h3>

                <p className="mt-1 text-sm text-slate-500">
                  {item.class.description || "No description available"}
                </p>
              </div>

              <span
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  item.isActive
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-red-100 text-red-700"
                }`}
              >
                {item.isActive ? "Active" : "Removed"}
              </span>
            </div>
          </div>

          {/* Details */}
          <div className="grid gap-4 p-6 md:grid-cols-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Schedule
              </p>

              <div className="mt-2 flex items-center gap-2">
                <Calendar className="h-4 w-4 text-slate-500" />
                <span className="text-sm font-medium">
                  {item.class.schedule}
                </span>
              </div>
            </div>

            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Monthly Fee
              </p>

              <p className="mt-2 text-lg font-semibold text-slate-900">
                Rs. {item.class.monthlyFee}
              </p>
            </div>

            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Assigned Date
              </p>

              <p className="mt-2 text-sm font-medium">
                {new Date(item.assignedAt).toLocaleDateString()}
              </p>
            </div>
          </div>

          {/* Payments */}
          <div className="border-t border-slate-100 px-6 py-4">
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-slate-800">
                Payments
              </h4>

              <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
                {item.class.payments.length} Records
              </span>
            </div>

            {item.class.payments.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                No payments recorded.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {item.class.payments.map((payment: ClassPaymentRecord) => (
                  <div
                    key={payment.id}
                    className="flex items-center justify-between rounded-lg border border-slate-100 p-3"
                  >
                    <span>{payment.month}</span>

                    <span
                      className={`rounded-full px-2 py-1 text-xs font-medium ${
                        payment.status === "CONFIRMED"
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {payment.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* History */}
          <div className="border-t border-slate-100 px-6 py-4">
            <h4 className="mb-4 font-medium text-slate-800">
              Assignment History
            </h4>

            <div className="space-y-4">
              {item.class.studentHistory.map((history: ClassHistoryRecord) => (
                <div
                  key={history.id}
                  className="flex gap-3"
                >
                  <div className="mt-1">
                    <ChevronRight className="h-4 w-4 text-slate-400" />
                  </div>

                  <div>
                    <p className="text-sm font-medium text-slate-800">
                      {history.action}
                    </p>

                    <p className="text-xs text-slate-500">
                      {new Date(
                        history.actionDate
                      ).toLocaleString()}
                    </p>

                    {history.reason && (
                      <p className="mt-1 text-sm text-red-600">
                        Reason: {history.reason}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}



