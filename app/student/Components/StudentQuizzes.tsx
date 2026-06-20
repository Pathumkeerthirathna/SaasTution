"use client";

import {
  FileQuestion,
  CheckCircle,
  XCircle,
  Trophy,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface QuizSummary {
  attempted: number;
  passed: number;
  failed: number;
  totalScore: number;
  totalQuizzes: number;
  missed:number;
  averageScore: number;
}

interface QuizRecord {
  id: string;
  title: string;
  score: number | null;
  totalScore: number;
  passed: boolean;
  submittedAt: string | null;
  quizId: string;
  quizTitle: string;
  lectureTitle: string;
  totalQuestions: number;
  percentage: number | null;
  attempted: boolean;
}

interface ClassQuiz {
  classId: string;
  className: string;
  quizzesCount: number;
  totalQuizzes: number;
  attempted: number;
  missed: number;
  averageScore: number;
}

interface StudentQuizzesProps {
  studentId: string;
}

export function StudentQuizzes({
  studentId,
}: StudentQuizzesProps) {
  const [summary, setSummary] = useState<QuizSummary | null>(null);
  const [classes, setClasses] = useState<ClassQuiz[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedClassId, setSelectedClassId] =
    useState<string | null>(null);

  const [quizzes, setQuizzes] = useState<QuizRecord[]>([]);

  const loadQuizSummary = useCallback(async () => {
    try {
      setLoading(true);

      const response = await fetch(
        `/api/student/Profile/${studentId}/quizzes`
      );

      const result = await response.json();

      if (result.success) {
        setSummary(result.data.summary);
        setClasses(result.data.classes);
      }
    } finally {
      setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    loadQuizSummary();
  }, [loadQuizSummary]);

  async function toggleQuizDetails(
    classId: string
  ) {
    if (selectedClassId === classId) {
      setSelectedClassId(null);
      setQuizzes([]);
      return;
    }

    const response = await fetch(
      `/api/student/Profile/${studentId}/quizzes/${classId}`
    );

    const result = await response.json();

    console.log(result);  

    if (result.success) {
      setSelectedClassId(classId);
      //setQuizzes(result.data);
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        Loading quizzes...
      </div>
    );
  }

  return (
    <div className="space-y-5">

      {/* Summary */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-3">
            <FileQuestion className="h-5 w-5 text-blue-600" />

            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Quiz Overview
              </h2>

              <p className="text-sm text-slate-500">
                Student quiz performance
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 p-5 md:grid-cols-4">
          <div className="rounded-lg bg-blue-50 p-4">
            <p className="text-xs uppercase text-blue-600">
              Total Quizzes
            </p>

            <p className="mt-2 text-2xl font-bold text-blue-700">
              {summary?.totalQuizzes ?? 0}
            </p>
          </div>

          <div className="rounded-lg bg-emerald-50 p-4">
            <p className="text-xs uppercase text-emerald-600">
              Attempted
            </p>

            <p className="mt-2 text-2xl font-bold text-emerald-700">
              {summary?.attempted ?? 0}
            </p>
          </div>

          <div className="rounded-lg bg-red-50 p-4">
            <p className="text-xs uppercase text-red-600">
              Missed
            </p>

            <p className="mt-2 text-2xl font-bold text-red-700">
              {summary?.missed ?? 0}
            </p>
          </div>

          <div className="rounded-lg bg-amber-50 p-4">
            <p className="text-xs uppercase text-amber-600">
              Average Score
            </p>

            <p className="mt-2 text-2xl font-bold text-amber-700">
              {summary?.averageScore ?? 0}%
            </p>
          </div>
        </div>
      </div>

      {/* Class Cards */}
      {classes.map((item) => (
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
                  Quiz Performance Summary
                </p>
              </div>

              <button
                onClick={() =>
                  toggleQuizDetails(item.classId)
                }
                className={`rounded-lg px-4 py-2 text-sm font-medium ${
                  selectedClassId === item.classId
                    ? "bg-slate-200 text-slate-700"
                    : "bg-blue-600 text-white"
                }`}
              >
                {selectedClassId === item.classId
                  ? "Hide Details"
                  : "View Details"}
              </button>
            </div>
          </div>

          <div className="grid gap-4 p-5 md:grid-cols-4">
            <div>
              <p className="text-xs uppercase text-slate-500">
                Total Quizzes
              </p>

              <p className="mt-1 text-xl font-semibold">
                {item.totalQuizzes}
              </p>
            </div>

            <div>
              <p className="text-xs uppercase text-slate-500">
                Attempted
              </p>

              <p className="mt-1 text-xl font-semibold text-emerald-600">
                {item.attempted}
              </p>
            </div>

            <div>
              <p className="text-xs uppercase text-slate-500">
                Missed
              </p>

              <p className="mt-1 text-xl font-semibold text-red-600">
                {item.missed}
              </p>
            </div>

            <div>
              <p className="text-xs uppercase text-slate-500">
                Average Score
              </p>

              <p className="mt-1 text-xl font-semibold text-amber-600">
                {item.averageScore}%
              </p>
            </div>
          </div>

          {selectedClassId === item.classId && (
            <div className="border-t border-slate-100">
              <div className="px-5 py-4">
                <h4 className="font-semibold text-slate-900">
                  Quiz History
                </h4>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                        Quiz
                      </th>

                      <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                        Status
                      </th>

                      <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                        Score
                      </th>

                      <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                        Percentage
                      </th>

                      <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                        Submitted
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {quizzes.map((quiz) => (
                      <tr
                        key={quiz.quizId}
                        className="border-t"
                      >
                        <td className="px-5 py-4">
                          <div>
                            <div className="font-medium">
                              {quiz.quizTitle}
                            </div>

                            <div className="text-xs text-slate-500">
                              {quiz.lectureTitle}
                            </div>
                          </div>
                        </td>

                        <td className="px-5 py-4">
                          {quiz.attempted ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700">
                              <CheckCircle className="h-3 w-3" />
                              Completed
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">
                              <XCircle className="h-3 w-3" />
                              Missed
                            </span>
                          )}
                        </td>

                        <td className="px-5 py-4">
                          {quiz.attempted
                            ? `${quiz.score}/${quiz.totalQuestions}`
                            : "-"}
                        </td>

                        <td className="px-5 py-4">
                          {quiz.attempted ? (
                            <span className="inline-flex items-center gap-1">
                              <Trophy className="h-4 w-4 text-amber-500" />
                              {quiz.percentage}%
                            </span>
                          ) : (
                            "-"
                          )}
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-500">
                          {quiz.submittedAt
                            ? new Date(
                                quiz.submittedAt
                              ).toLocaleDateString()
                            : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {quizzes.length === 0 && (
                  <div className="p-6 text-center text-sm text-slate-500">
                    No quizzes found.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}