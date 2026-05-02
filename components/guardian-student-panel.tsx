"use client";

import { useEffect, useState } from "react";

type GuardianOverview = {
  guardian: {
    id: string;
    name: string;
    relation: string;
    phone: string;
    email: string | null;
  };
  student: {
    id: string;
    name: string;
    grade: string | null;
    contact: string;
    classes: {
      id: string;
      name: string;
      schedule: string;
      description: string | null;
    }[];
  };
};

export function GuardianStudentPanel() {
  const [data, setData] = useState<GuardianOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    async function loadOverview() {
      setIsLoading(true);
      setErrorMessage(null);

      try {
        const response = await fetch("/api/guardian-auth/me");
        const payload = (await response.json()) as {
          success: boolean;
          data?: GuardianOverview;
          error?: { message?: string };
        };

        if (!response.ok || !payload.success || !payload.data) {
          setErrorMessage(payload.error?.message ?? "Failed to load guardian data.");
          return;
        }

        setData(payload.data);
      } catch {
        setErrorMessage("Unable to load guardian data right now.");
      } finally {
        setIsLoading(false);
      }
    }

    void loadOverview();
  }, []);

  if (isLoading) {
    return <p className="mt-6 text-sm text-muted">Loading student details...</p>;
  }

  if (errorMessage) {
    return <p className="mt-6 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>;
  }

  if (!data) {
    return <p className="mt-6 text-sm text-muted">No data available.</p>;
  }

  return (
    <section className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.8fr]">
      <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
        <h2 className="text-lg font-semibold">Guardian profile</h2>
        <p className="mt-3 text-sm font-medium">{data.guardian.name}</p>
        <p className="text-sm text-muted">Relation: {data.guardian.relation}</p>
        <p className="text-sm text-muted">Phone: {data.guardian.phone}</p>
        <p className="text-sm text-muted">Email: {data.guardian.email ?? "Not set"}</p>
      </article>

      <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
        <h2 className="text-lg font-semibold">Student information</h2>
        <p className="mt-3 text-base font-semibold">{data.student.name}</p>
        <p className="text-sm text-muted">{data.student.grade ? `Grade: ${data.student.grade}` : "Grade not provided"}</p>
        <p className="text-sm text-muted">Contact: {data.student.contact}</p>

        <div className="mt-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Enrolled classes</p>
          {data.student.classes.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No classes assigned yet.</p>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {data.student.classes.map((classroom) => (
                <div key={classroom.id} className="rounded-2xl border border-black/10 p-3 dark:border-white/10">
                  <p className="text-sm font-semibold">{classroom.name}</p>
                  <p className="text-xs text-muted">{classroom.schedule}</p>
                  <p className="mt-1 text-xs text-muted">{classroom.description || "No description provided."}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </article>
    </section>
  );
}
