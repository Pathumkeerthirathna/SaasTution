"use client";

// Teacher: the questions of a group quiz, in the existing breakout quiz input
// format (lib/breakout-activities/validation.ts quizDefinitionInputSchema):
// single / multiple choice (options with the correct one(s)), true / false,
// and short answer (accepted answers). The server validates and assigns ids.

import { Plus, Trash2 } from "lucide-react";

export type DraftQuestion = {
  key: string;
  kind: "single" | "multiple" | "true_false" | "short";
  prompt: string;
  marks: string;
  options: { key: string; text: string; correct: boolean }[];
  correct: boolean;
  acceptedAnswers: string;
};

let counter = 0;
const nextKey = () => `k${Date.now().toString(36)}${(counter += 1)}`;

export function newQuestion(kind: DraftQuestion["kind"] = "single"): DraftQuestion {
  return {
    key: nextKey(),
    kind,
    prompt: "",
    marks: "1",
    options: [
      { key: nextKey(), text: "", correct: true },
      { key: nextKey(), text: "", correct: false },
    ],
    correct: true,
    acceptedAnswers: "",
  };
}

/** The draft as the API's quiz input (the server re-checks everything). */
export function toQuestionInput(questions: DraftQuestion[]) {
  return questions.map((q) => {
    const base = { prompt: q.prompt.trim(), marks: Number(q.marks) };
    switch (q.kind) {
      case "single":
      case "multiple":
        return { kind: q.kind, ...base, options: q.options.map((o) => ({ text: o.text.trim(), correct: o.correct })) };
      case "true_false":
        return { kind: q.kind, ...base, correct: q.correct };
      case "short":
        return {
          kind: q.kind,
          ...base,
          acceptedAnswers: q.acceptedAnswers
            .split(/\r?\n/)
            .map((a) => a.trim())
            .filter((a) => a !== ""),
        };
    }
  });
}

const input = "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none";

export default function GroupQuizBuilder({ questions, onChange }: { questions: DraftQuestion[]; onChange: (next: DraftQuestion[]) => void }) {
  const update = (key: string, change: Partial<DraftQuestion>) => onChange(questions.map((q) => (q.key === key ? { ...q, ...change } : q)));

  return (
    <div className="space-y-3">
      {questions.map((q, index) => (
        <div key={q.key} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-600">Question {index + 1}</span>
            <select
              aria-label="Question type"
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
              value={q.kind}
              onChange={(e) => update(q.key, { kind: e.target.value as DraftQuestion["kind"] })}
            >
              <option value="single">Single choice</option>
              <option value="multiple">Multiple choice</option>
              <option value="true_false">True / false</option>
              <option value="short">Short answer</option>
            </select>
            <label className="ml-auto flex items-center gap-1 text-xs text-slate-600">
              Marks
              <input
                className="w-16 rounded-md border border-slate-300 px-1.5 py-1 text-xs"
                inputMode="decimal"
                value={q.marks}
                onChange={(e) => update(q.key, { marks: e.target.value })}
              />
            </label>
            <button
              type="button"
              aria-label="Remove question"
              className="rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-red-600"
              onClick={() => onChange(questions.filter((x) => x.key !== q.key))}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <textarea className={`${input} mb-2`} rows={2} placeholder="Question" value={q.prompt} onChange={(e) => update(q.key, { prompt: e.target.value })} />

          {(q.kind === "single" || q.kind === "multiple") && (
            <div className="space-y-1.5">
              {q.options.map((o) => (
                <div key={o.key} className="flex items-center gap-2">
                  <input
                    type={q.kind === "single" ? "radio" : "checkbox"}
                    name={`correct-${q.key}`}
                    aria-label="Correct answer"
                    checked={o.correct}
                    onChange={(e) =>
                      update(q.key, {
                        options: q.options.map((x) =>
                          q.kind === "single" ? { ...x, correct: x.key === o.key } : x.key === o.key ? { ...x, correct: e.target.checked } : x
                        ),
                      })
                    }
                  />
                  <input
                    className={input}
                    placeholder="Option"
                    value={o.text}
                    onChange={(e) => update(q.key, { options: q.options.map((x) => (x.key === o.key ? { ...x, text: e.target.value } : x)) })}
                  />
                  <button
                    type="button"
                    aria-label="Remove option"
                    className="rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-red-600"
                    onClick={() => update(q.key, { options: q.options.filter((x) => x.key !== o.key) })}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline"
                onClick={() => update(q.key, { options: [...q.options, { key: nextKey(), text: "", correct: false }] })}
              >
                <Plus size={12} /> Add option
              </button>
            </div>
          )}

          {q.kind === "true_false" && (
            <div className="flex gap-4 text-sm text-slate-700">
              {[true, false].map((value) => (
                <label key={String(value)} className="flex items-center gap-1">
                  <input type="radio" name={`tf-${q.key}`} checked={q.correct === value} onChange={() => update(q.key, { correct: value })} />
                  {value ? "True" : "False"} is correct
                </label>
              ))}
            </div>
          )}

          {q.kind === "short" && (
            <textarea
              className={input}
              rows={2}
              placeholder="Accepted answers, one per line"
              value={q.acceptedAnswers}
              onChange={(e) => update(q.key, { acceptedAnswers: e.target.value })}
            />
          )}
        </div>
      ))}
      <button
        type="button"
        className="flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        onClick={() => onChange([...questions, newQuestion()])}
      >
        <Plus size={13} /> Add question
      </button>
    </div>
  );
}
