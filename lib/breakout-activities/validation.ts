// Request and JSON-column validation for Breakout Room Activities (zod 4).
//
// Two shapes of a quiz definition:
//  - INPUT  (from the teacher): no IDs; correct options are marked with
//           `correct: true`. assignServerIds() turns it into the stored shape.
//  - STORED (BreakoutQuiz.questions): server-generated question and option
//           IDs, answer keys by ID. Re-validated whenever it is read.
//
// Limits are the approved V4 contract values.

import { z } from "zod";
import { normalizeShortAnswer, type QuizAnswers, type QuizDefinition, type QuizQuestion } from "./marking.mjs";
import { IDEMPOTENCY_KEY_PATTERN, MAX_ANSWER_TEXT_LENGTH } from "./submission-rules.mjs";

export const BREAKOUT_LIMITS = {
  titleMax: 200,
  instructionsMax: 20_000,
  roomNameMax: 120,
  targetsMax: 50,
  questionsMin: 1,
  questionsMax: 100,
  promptMax: 2_000,
  optionsMin: 2,
  optionsMax: 10,
  optionTextMax: 500,
  marksMax: 100,
  acceptedAnswersMin: 1,
  acceptedAnswersMax: 20,
  acceptedAnswerMax: 500,
  shortAnswerMax: 1_000,
  answerTextMax: MAX_ANSWER_TEXT_LENGTH,
  timeLimitMin: 60,
  timeLimitMax: 14_400,
  overridesMax: 100,
  overrideNoteMax: 500,
} as const;

/** Server-generated question/option IDs. Never "__proto__"-like names. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);
/** Jitsi breakout room IDs, e.g. "0abad041-…@breakout.meet.example". */
const ROOM_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,255}$/;

const entityId = z
  .string()
  .regex(ID_PATTERN, "Invalid id.")
  .refine((s) => !RESERVED_IDS.has(s), "Invalid id.");

const hasAtMostTwoDecimals = (n: number) => Math.abs(Math.round(n * 100) - n * 100) <= 1e-6;

/** > 0, ≤ 100, at most 2 decimals. */
export const marksSchema = z
  .number()
  .finite()
  .gt(0, "Marks must be greater than 0.")
  .lte(BREAKOUT_LIMITS.marksMax, `Marks can be at most ${BREAKOUT_LIMITS.marksMax}.`)
  .refine(hasAtMostTwoDecimals, "Marks can have at most 2 decimal places.");

const prompt = z.string().trim().min(1, "Question text is required.").max(BREAKOUT_LIMITS.promptMax);
const optionText = z.string().trim().min(1, "Option text is required.").max(BREAKOUT_LIMITS.optionTextMax);
const acceptedAnswers = z
  .array(z.string().max(BREAKOUT_LIMITS.acceptedAnswerMax))
  .min(BREAKOUT_LIMITS.acceptedAnswersMin)
  .max(BREAKOUT_LIMITS.acceptedAnswersMax)
  .refine((list) => list.every((a) => normalizeShortAnswer(a) !== ""), "Accepted answers cannot be empty.");
const options = <T extends z.ZodType>(item: T) =>
  z.array(item).min(BREAKOUT_LIMITS.optionsMin).max(BREAKOUT_LIMITS.optionsMax);

// ---- Quiz definition: teacher input ------------------------------------------

const inputOption = z.strictObject({ text: optionText, correct: z.boolean().optional() });
const countCorrect = (opts: { correct?: boolean }[]) => opts.filter((o) => o.correct === true).length;

const inputQuestion = z.discriminatedUnion("kind", [
  z
    .strictObject({ kind: z.literal("single"), prompt, marks: marksSchema, options: options(inputOption) })
    .refine((q) => countCorrect(q.options) === 1, { message: "Mark exactly one correct option.", path: ["options"] }),
  z
    .strictObject({ kind: z.literal("multiple"), prompt, marks: marksSchema, options: options(inputOption) })
    .refine((q) => countCorrect(q.options) >= 1, { message: "Mark at least one correct option.", path: ["options"] }),
  z.strictObject({ kind: z.literal("true_false"), prompt, marks: marksSchema, correct: z.boolean() }),
  z.strictObject({ kind: z.literal("short"), prompt, marks: marksSchema, acceptedAnswers }),
]);

export const quizDefinitionInputSchema = z
  .array(inputQuestion)
  .min(BREAKOUT_LIMITS.questionsMin, "Add at least one question.")
  .max(BREAKOUT_LIMITS.questionsMax, `A quiz can have at most ${BREAKOUT_LIMITS.questionsMax} questions.`);

export type QuizDefinitionInput = z.infer<typeof quizDefinitionInputSchema>;

/** A fresh random ID (browser and Node). */
export function defaultIdGenerator(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/**
 * Teacher input -> stored definition, with server-generated IDs ("q…" for
 * questions, "o…" for options). The generator is injectable for tests; IDs
 * must be unique within the quiz.
 */
export function assignServerIds(input: QuizDefinitionInput, nextId: () => string = defaultIdGenerator): QuizDefinition {
  const used = new Set<string>();
  const make = (prefix: string) => {
    for (let i = 0; i < 5; i += 1) {
      const id = `${prefix}${nextId()}`;
      if (ID_PATTERN.test(id) && !used.has(id)) {
        used.add(id);
        return id;
      }
    }
    throw new Error("Could not generate a unique id.");
  };
  const questions: QuizQuestion[] = input.map((q) => {
    const id = make("q");
    switch (q.kind) {
      case "single":
      case "multiple": {
        const opts = q.options.map((o) => ({ id: make("o"), text: o.text, correct: o.correct === true }));
        const stripped = opts.map(({ id: oid, text }) => ({ id: oid, text }));
        return q.kind === "single"
          ? { id, kind: "single", prompt: q.prompt, marks: q.marks, options: stripped, correctOptionId: opts.find((o) => o.correct)!.id }
          : { id, kind: "multiple", prompt: q.prompt, marks: q.marks, options: stripped, correctOptionIds: opts.filter((o) => o.correct).map((o) => o.id) };
      }
      case "true_false":
        return { id, kind: "true_false", prompt: q.prompt, marks: q.marks, correct: q.correct };
      case "short":
        return { id, kind: "short", prompt: q.prompt, marks: q.marks, acceptedAnswers: q.acceptedAnswers.map((a) => a.trim()) };
    }
  });
  return storedQuizDefinitionSchema.parse({ schemaVersion: 1, questions });
}

// ---- Quiz definition: stored --------------------------------------------------

const storedOption = z.strictObject({ id: entityId, text: optionText });
const uniqueIds = (opts: { id: string }[]) => new Set(opts.map((o) => o.id)).size === opts.length;

const storedQuestion = z.discriminatedUnion("kind", [
  z
    .strictObject({ id: entityId, kind: z.literal("single"), prompt, marks: marksSchema, options: options(storedOption), correctOptionId: entityId })
    .refine((q) => uniqueIds(q.options), { message: "Duplicate option ids.", path: ["options"] })
    .refine((q) => q.options.some((o) => o.id === q.correctOptionId), { message: "The correct option is not one of the options.", path: ["correctOptionId"] }),
  z
    .strictObject({ id: entityId, kind: z.literal("multiple"), prompt, marks: marksSchema, options: options(storedOption), correctOptionIds: z.array(entityId).min(1) })
    .refine((q) => uniqueIds(q.options), { message: "Duplicate option ids.", path: ["options"] })
    .refine((q) => new Set(q.correctOptionIds).size === q.correctOptionIds.length, { message: "Duplicate correct options.", path: ["correctOptionIds"] })
    .refine((q) => q.correctOptionIds.every((id) => q.options.some((o) => o.id === id)), { message: "A correct option is not one of the options.", path: ["correctOptionIds"] }),
  z.strictObject({ id: entityId, kind: z.literal("true_false"), prompt, marks: marksSchema, correct: z.boolean() }),
  z.strictObject({ id: entityId, kind: z.literal("short"), prompt, marks: marksSchema, acceptedAnswers }),
]);

export const storedQuizDefinitionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    questions: z.array(storedQuestion).min(BREAKOUT_LIMITS.questionsMin).max(BREAKOUT_LIMITS.questionsMax),
  })
  .refine((d) => new Set(d.questions.map((q) => q.id)).size === d.questions.length, { message: "Duplicate question ids.", path: ["questions"] })
  .transform((d) => d as QuizDefinition);

// ---- Student answers ----------------------------------------------------------

const answerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("single"), optionId: entityId.nullable() }),
  z.strictObject({ kind: z.literal("multiple"), optionIds: z.array(entityId).max(BREAKOUT_LIMITS.optionsMax) }),
  z.strictObject({ kind: z.literal("true_false"), value: z.boolean().nullable() }),
  z.strictObject({ kind: z.literal("short"), text: z.string().max(BREAKOUT_LIMITS.shortAnswerMax) }),
]);

const answersShape = z.record(entityId, answerSchema);

export type AnswerCheck = { ok: true; answers: QuizAnswers } | { ok: false; error: string };

/**
 * Answers for THIS quiz: known questions only, matching kinds, options that
 * belong to the question. Partial answers are fine (saving in progress).
 * Duplicate selections are removed.
 */
export function validateAnswersAgainstDefinition(definition: QuizDefinition, raw: unknown): AnswerCheck {
  // Checked on the raw object: an own "__proto__" key (JSON.parse creates
  // one) would otherwise vanish silently during parsing instead of failing.
  if (raw && typeof raw === "object" && Object.keys(raw).some((k) => RESERVED_IDS.has(k))) {
    return { ok: false, error: "Invalid answers." };
  }
  const parsed = answersShape.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid answers." };
  const byId = new Map(definition.questions.map((q) => [q.id, q]));
  const answers: QuizAnswers = {};
  for (const [questionId, answer] of Object.entries(parsed.data)) {
    const question = byId.get(questionId);
    if (!question) return { ok: false, error: "Answer for a question that is not in this quiz." };
    if (answer.kind !== question.kind) return { ok: false, error: "Answer type does not match the question." };
    if (answer.kind === "single" && question.kind === "single") {
      if (answer.optionId !== null && !question.options.some((o) => o.id === answer.optionId)) {
        return { ok: false, error: "Unknown option." };
      }
    }
    if (answer.kind === "multiple" && question.kind === "multiple") {
      const ids = [...new Set(answer.optionIds)];
      if (!ids.every((id) => question.options.some((o) => o.id === id))) return { ok: false, error: "Unknown option." };
      answers[questionId] = { kind: "multiple", optionIds: ids };
      continue;
    }
    answers[questionId] = answer;
  }
  return { ok: true, answers };
}

// ---- Request bodies -----------------------------------------------------------

const title = z.string().trim().min(1, "Title is required.").max(BREAKOUT_LIMITS.titleMax);
const instructions = z.string().trim().max(BREAKOUT_LIMITS.instructionsMax);

export const targetSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("MAIN") }),
  z.strictObject({ type: z.literal("BREAKOUT"), id: z.string().regex(ROOM_ID_PATTERN, "Invalid room id.") }),
]);

export const targetsSchema = z
  .array(targetSchema)
  .min(1, "Choose at least one room.")
  .max(BREAKOUT_LIMITS.targetsMax)
  .refine((t) => new Set(t.map((x) => (x.type === "MAIN" ? "MAIN" : `B:${x.id}`))).size === t.length, "A room is chosen twice.");

/** Multipart fields of POST …/assignments, after form parsing (the brief PDF is checked by pdf-file.ts). */
export const assignmentCreateSchema = z.strictObject({
  title,
  instructions,
  targets: targetsSchema,
  publish: z.boolean(),
});

export const timeLimitSecondsSchema = z
  .number()
  .int()
  .min(BREAKOUT_LIMITS.timeLimitMin)
  .max(BREAKOUT_LIMITS.timeLimitMax);

export const quizCreateSchema = z.strictObject({
  title,
  instructions: instructions.optional(),
  timeLimitSeconds: timeLimitSecondsSchema.nullable().optional(),
  questions: quizDefinitionInputSchema,
  targets: targetsSchema,
  publish: z.boolean(),
});

const revision = z.number().int().min(0);

export const idempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY_PATTERN, "Invalid idempotency key.");

/** Written answer text (draft and submission). The text-or-PDF rule is checkSubmissionContent(). */
export const answerTextSchema = z.string().max(BREAKOUT_LIMITS.answerTextMax, "The answer is too long.");

export const draftSaveSchema = z.strictObject({ revision, answerText: answerTextSchema });

export const quizAnswersSaveSchema = z.strictObject({ revision, answers: z.unknown() });

export const quizSubmitSchema = z.strictObject({ revision });

export const gradingOverridesSchema = z.strictObject({
  overrides: z
    .array(
      z.strictObject({
        questionId: entityId,
        marks: z.number().finite().min(0).refine(hasAtMostTwoDecimals, "Marks can have at most 2 decimal places.").nullable(),
        note: z.string().max(BREAKOUT_LIMITS.overrideNoteMax).optional(),
      })
    )
    .min(1)
    .max(BREAKOUT_LIMITS.overridesMax),
});

export type AssignmentCreateInput = z.infer<typeof assignmentCreateSchema>;
export type QuizCreateInput = z.infer<typeof quizCreateSchema>;
export type DraftSaveInput = z.infer<typeof draftSaveSchema>;
export type GradingOverridesInput = z.infer<typeof gradingOverridesSchema>;
export type BreakoutTarget = z.infer<typeof targetSchema>;
