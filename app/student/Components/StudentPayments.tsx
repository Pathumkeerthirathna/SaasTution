"use client";

import {
  CreditCard,
  CheckCircle,
  Clock3,
  AlertCircle,
} from "lucide-react";
import { useEffect, useState } from "react";

interface StudentPaymentsProps {
  studentId: string;
}

export function StudentPayments({
  studentId,
}: StudentPaymentsProps) {
  const [summary, setSummary] = useState<any>(null);
  const [classes, setClasses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedClassId, setSelectedClassId] =
    useState<string | null>(null);

  const [payments, setPayments] = useState<any[]>([]);

  useEffect(() => {
    loadPayments();
  }, [studentId]);

  async function loadPayments() {
    try {
      setLoading(true);

      const response = await fetch(
        `/api/student/Profile/${studentId}/payments`
      );

      const result = await response.json();

      if (result.success) {
        setSummary(result.data.summary);
        setClasses(result.data.classes);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  async function togglePaymentDetails(
    classId: string
  ) {
    if (selectedClassId === classId) {
      setSelectedClassId(null);
      setPayments([]);
      return;
    }

    try {
      setSelectedClassId(classId);

      const response = await fetch(
        `/api/student/Profile/${studentId}/payments/${classId}`
      );

      const result = await response.json();

      if (result.success) {
        setPayments(result.data);
      }
    } catch (error) {
      console.error(error);
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        Loading payments...
      </div>
    );
  }

  return (
    <div className="space-y-5">

      {/* Summary */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-3">
            <CreditCard className="h-5 w-5 text-blue-600" />

            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Payments Overview
              </h2>

              <p className="text-sm text-slate-500">
                Student payment statistics
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 p-5 md:grid-cols-4">
          <div className="rounded-lg bg-emerald-50 p-4">
            <p className="text-xs uppercase text-emerald-600">
              Confirmed
            </p>

            <p className="mt-2 text-2xl font-bold text-emerald-700">
              {summary?.confirmed ?? 0}
            </p>
          </div>

          <div className="rounded-lg bg-amber-50 p-4">
            <p className="text-xs uppercase text-amber-600">
              Pending
            </p>

            <p className="mt-2 text-2xl font-bold text-amber-700">
              {summary?.pending ?? 0}
            </p>
          </div>

          <div className="rounded-lg bg-red-50 p-4">
            <p className="text-xs uppercase text-red-600">
              Clarification
            </p>

            <p className="mt-2 text-2xl font-bold text-red-700">
              {summary?.clarification ?? 0}
            </p>
          </div>

          <div className="rounded-lg bg-blue-50 p-4">
            <p className="text-xs uppercase text-blue-600">
              Total Paid
            </p>

            <p className="mt-2 text-2xl font-bold text-blue-700">
              Rs.{" "}
              {(summary?.totalPaid ?? 0).toLocaleString()}
            </p>
          </div>
        </div>
      </div>

      {/* Classes */}
      {classes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-slate-500">
            No payment records found.
          </p>
        </div>
      ) : (
        classes.map((item) => (
          <div
            key={item.classId}
            className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
          >
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-slate-900">
                    {item.className}
                  </h3>

                  <p className="text-sm text-slate-500">
                    Monthly Fee: Rs.{" "}
                    {item.monthlyFee.toLocaleString()}
                  </p>
                </div>

                <button
                  onClick={() =>
                    togglePaymentDetails(item.classId)
                  }
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                    selectedClassId === item.classId
                      ? "bg-slate-200 text-slate-700"
                      : "bg-blue-600 text-white hover:bg-blue-700"
                  }`}
                >
                  {selectedClassId === item.classId
                    ? "Hide Details"
                    : "View Details"}
                </button>
              </div>
            </div>

            <div className="grid gap-4 p-5 md:grid-cols-3">
              <div>
                <p className="text-xs uppercase text-slate-500">
                  Paid Months
                </p>

                <p className="mt-1 text-xl font-semibold text-emerald-600">
                  {item.paidMonths}
                </p>
              </div>

              <div>
                <p className="text-xs uppercase text-slate-500">
                  Pending Months
                </p>

                <p className="mt-1 text-xl font-semibold text-amber-600">
                  {item.pendingMonths}
                </p>
              </div>

              <div>
                <p className="text-xs uppercase text-slate-500">
                  Total Amount
                </p>

                <p className="mt-1 text-xl font-semibold text-slate-900">
                  Rs.{" "}
                  {item.totalAmount.toLocaleString()}
                </p>
              </div>
            </div>

            {selectedClassId === item.classId && (
              <div className="border-t border-slate-100">
                <div className="px-5 py-4">
                  <h4 className="font-semibold text-slate-900">
                    Payment History
                  </h4>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                          Month
                        </th>

                        <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                          Amount
                        </th>

                        <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                          Status
                        </th>

                        <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                          Submitted
                        </th>
                      </tr>
                    </thead>

                    <tbody>
                      {payments.map((payment) => (
                        <tr
                          key={payment.id}
                          className="border-t"
                        >
                          <td className="px-5 py-4">
                            {payment.month}
                          </td>

                          <td className="px-5 py-4">
                            Rs.{" "}
                            {payment.amount.toLocaleString()}
                          </td>

                          <td className="px-5 py-4">
                            <span
                              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${
                                payment.status ===
                                "CONFIRMED"
                                  ? "bg-emerald-100 text-emerald-700"
                                  : payment.status ===
                                    "PENDING"
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-red-100 text-red-700"
                              }`}
                            >
                              {payment.status ===
                                "CONFIRMED" && (
                                <CheckCircle className="h-3 w-3" />
                              )}

                              {payment.status ===
                                "PENDING" && (
                                <Clock3 className="h-3 w-3" />
                              )}

                              {payment.status !==
                                "CONFIRMED" &&
                                payment.status !==
                                  "PENDING" && (
                                  <AlertCircle className="h-3 w-3" />
                                )}

                              {payment.status}
                            </span>
                          </td>

                          <td className="px-5 py-4 text-sm text-slate-500">
                            {payment.submittedAt
                              ? new Date(
                                  payment.submittedAt
                                ).toLocaleDateString()
                              : "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {payments.length === 0 && (
                    <div className="p-6 text-center text-sm text-slate-500">
                      No payment history found.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}