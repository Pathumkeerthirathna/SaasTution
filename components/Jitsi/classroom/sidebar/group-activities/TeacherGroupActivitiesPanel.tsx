"use client";

// Teacher: Group Activities.
//
//   1. Groups: the EXISTING breakout rooms (created and filled with the
//      existing Breakout Rooms panel, which this panel never changes) with
//      the class students the page sees in each, next to the members already
//      confirmed. The teacher selects rooms and confirms their members; when
//      students move, the difference is shown and the teacher confirms again.
//   2. New activity: an assignment or a quiz for the selected rooms (their
//      members are confirmed in the same request), published now or kept as
//      a draft.
//   3. Progress: per room, its members and every group activity with its
//      progress and submission status; publish / close (the existing
//      routes); the work, answers, results and mark overrides in detail.

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";

import type { BreakoutController } from "../../../hooks/useBreakoutRooms";
import type { ClassroomStudent } from "../../../types";
import { formatTime, groupApi, groupUrls, jsonInit } from "./api";
import GroupQuizBuilder, { newQuestion, toQuestionInput, type DraftQuestion } from "./GroupQuizBuilder";
import { useGroupResource } from "./hooks";
import { proposeRooms, type ProposedRoom } from "./proposal";
import TeacherActivityDetail from "./TeacherActivityDetail";
import type { TeacherOverview } from "./types";

type Props = {
  sessionId: string;
  breakout?: BreakoutController;
  studentLocations?: ReadonlyMap<string, { participantId: string }>;
  students?: ClassroomStudent[];
};

const primary = "rounded-md bg-[#4D6C90] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#3B5776] disabled:opacity-50";
const secondary = "rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50";
const field = "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none";

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function stateBadge(state: string) {
  const tone = state === "PUBLISHED" ? "bg-emerald-100 text-emerald-800" : state === "CLOSED" ? "bg-slate-200 text-slate-700" : "bg-amber-100 text-amber-800";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}>{state.toLowerCase()}</span>;
}

export default function TeacherGroupActivitiesPanel({ sessionId, breakout, studentLocations, students }: Props) {
  const urls = groupUrls(sessionId);
  const overview = useGroupResource<TeacherOverview>(urls.teacherOverview);
  const proposal = useMemo(() => proposeRooms(breakout?.breakoutRooms, studentLocations, students), [breakout?.breakoutRooms, studentLocations, students]);
  const confirmedOf = useMemo(() => new Map((overview.data?.rooms ?? []).map((room) => [room.id, room])), [overview.data]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedRooms = proposal.filter((room) => selected.has(room.id));
  const roomPayload = (rooms: ProposedRoom[]) => rooms.map((room) => ({ id: room.id, name: room.name, studentIds: room.students.map((s) => s.studentId) }));

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const confirmMembers = async () => {
    if (selectedRooms.length === 0) return;
    setBusy(true);
    const result = await groupApi(urls.teacherMembers, jsonInit("PUT", { rooms: roomPayload(selectedRooms) }));
    setBusy(false);
    setNotice(result.ok ? { tone: "ok", text: "Group members confirmed." } : { tone: "error", text: result.message });
    if (result.ok) void overview.reload();
  };

  return (
    <div className="space-y-3 text-slate-900">
      {notice ? (
        <p className={`rounded-md px-3 py-2 text-xs ${notice.tone === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{notice.text}</p>
      ) : null}

      <Section
        title="Groups (existing breakout rooms)"
        action={
          <button type="button" className={primary} disabled={busy || selectedRooms.length === 0} onClick={() => void confirmMembers()}>
            Confirm members of selected rooms
          </button>
        }
      >
        {proposal.length === 0 ? (
          <p className="text-xs text-slate-500">No breakout rooms yet. Create them and assign students in the Breakout Rooms panel.</p>
        ) : (
          <ul className="space-y-2">
            {proposal.map((room) => {
              const confirmed = confirmedOf.get(room.id)?.members ?? [];
              const confirmedIds = new Set(confirmed.map((m) => m.id));
              const proposedIds = new Set(room.students.map((s) => s.studentId));
              const joined = room.students.filter((s) => !confirmedIds.has(s.studentId));
              const left = confirmed.filter((m) => !proposedIds.has(m.id));
              return (
                <li key={room.id} className="rounded-md border border-slate-200 p-2">
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-0.5" checked={selected.has(room.id)} onChange={() => toggle(room.id)} />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-medium">{room.name}</span>
                      <span className="block break-words text-xs text-slate-600">
                        In the room now: {room.students.length ? room.students.map((s) => s.name).join(", ") : "no class students"}
                        {room.otherOccupants ? ` (+${room.otherOccupants} other)` : ""}
                      </span>
                      <span className="block break-words text-xs text-slate-600">
                        Confirmed: {confirmed.length ? confirmed.map((m) => m.name).join(", ") : "not confirmed yet"}
                      </span>
                      {confirmed.length > 0 && (joined.length > 0 || left.length > 0) ? (
                        <span className="mt-0.5 block break-words text-xs font-medium text-amber-700">
                          Changed since confirmation:
                          {joined.length ? ` joined ${joined.map((s) => s.name).join(", ")}` : ""}
                          {left.length ? ` · left ${left.map((m) => m.name).join(", ")}` : ""} — select and confirm to update.
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <NewActivityForm
        sessionId={sessionId}
        rooms={selectedRooms}
        roomPayload={roomPayload}
        onCreated={(text) => {
          setNotice({ tone: "ok", text });
          void overview.reload();
        }}
        onError={(text) => setNotice({ tone: "error", text })}
      />

      <Section
        title="Group progress"
        action={
          <button type="button" className={secondary} onClick={() => void overview.reload()} aria-label="Refresh progress">
            <RefreshCw size={13} />
          </button>
        }
      >
        <ProgressList sessionId={sessionId} overview={overview.data} onChanged={() => void overview.reload()} onError={(text) => setNotice({ tone: "error", text })} />
      </Section>
    </div>
  );
}

function NewActivityForm({
  sessionId,
  rooms,
  roomPayload,
  onCreated,
  onError,
}: {
  sessionId: string;
  rooms: ProposedRoom[];
  roomPayload: (rooms: ProposedRoom[]) => { id: string; name: string; studentIds: string[] }[];
  onCreated: (text: string) => void;
  onError: (text: string) => void;
}) {
  const urls = groupUrls(sessionId);
  const [kind, setKind] = useState<"assignment" | "quiz">("assignment");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [brief, setBrief] = useState<File | null>(null);
  const [timeLimit, setTimeLimit] = useState("");
  const [questions, setQuestions] = useState<DraftQuestion[]>(() => [newQuestion()]);
  const [publish, setPublish] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fileKey, setFileKey] = useState(0);

  const create = async () => {
    if (rooms.length === 0) return;
    setBusy(true);
    let result;
    if (kind === "assignment") {
      const form = new FormData();
      form.set("title", title);
      form.set("instructions", instructions);
      form.set("rooms", JSON.stringify(roomPayload(rooms)));
      form.set("publish", publish ? "true" : "false");
      if (brief) form.set("brief", brief);
      result = await groupApi(urls.teacherCreateAssignment, { method: "POST", body: form });
    } else {
      const minutes = timeLimit.trim() === "" ? null : Math.round(Number(timeLimit) * 60);
      result = await groupApi(
        urls.teacherCreateQuiz,
        jsonInit("POST", {
          title,
          instructions,
          timeLimitSeconds: minutes,
          questions: toQuestionInput(questions),
          rooms: roomPayload(rooms),
          publish,
        })
      );
    }
    setBusy(false);
    if (!result.ok) {
      onError(result.message);
      return;
    }
    setTitle("");
    setInstructions("");
    setBrief(null);
    setFileKey((k) => k + 1);
    setQuestions([newQuestion()]);
    onCreated(`${kind === "assignment" ? "Group assignment" : "Group quiz"} ${publish ? "published" : "saved as draft"} for ${rooms.length} room${rooms.length === 1 ? "" : "s"}.`);
  };

  return (
    <Section title="New group activity">
      <div className="space-y-2">
        <div className="flex gap-2 text-xs">
          {(["assignment", "quiz"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`rounded-md px-3 py-1 font-semibold ${kind === value ? "bg-[#4D6C90] text-white" : "border border-slate-300 bg-white text-slate-700"}`}
              onClick={() => setKind(value)}
            >
              {value === "assignment" ? "Assignment" : "Quiz"}
            </button>
          ))}
        </div>
        <input className={field} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className={field} rows={3} placeholder="Instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        {kind === "assignment" ? (
          <label className="block text-xs text-slate-600">
            Brief PDF (optional)
            <input key={fileKey} type="file" accept="application/pdf" className="mt-1 block w-full text-xs" onChange={(e) => setBrief(e.target.files?.[0] ?? null)} />
          </label>
        ) : (
          <>
            <label className="flex items-center gap-2 text-xs text-slate-600">
              Time limit (minutes, optional)
              <input className="w-20 rounded-md border border-slate-300 px-2 py-1 text-xs" inputMode="numeric" value={timeLimit} onChange={(e) => setTimeLimit(e.target.value)} />
            </label>
            <GroupQuizBuilder questions={questions} onChange={setQuestions} />
          </>
        )}
        <p className="break-words text-xs text-slate-600">
          For: {rooms.length ? rooms.map((room) => `${room.name} (${room.students.length})`).join(", ") : "select rooms under Groups"}
        </p>
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish now
        </label>
        <button type="button" className={primary} disabled={busy || rooms.length === 0 || title.trim() === ""} onClick={() => void create()}>
          {publish ? "Publish to selected rooms" : "Save draft for selected rooms"}
        </button>
        <p className="text-[11px] text-slate-500">The selected rooms&apos; members are confirmed with this activity.</p>
      </div>
    </Section>
  );
}

function ProgressList({
  sessionId,
  overview,
  onChanged,
  onError,
}: {
  sessionId: string;
  overview: TeacherOverview | null;
  onChanged: () => void;
  onError: (text: string) => void;
}) {
  const urls = groupUrls(sessionId);
  const [open, setOpen] = useState<string | null>(null);

  if (!overview) return <p className="text-xs text-slate-500">Loading…</p>;
  if (overview.rooms.length === 0) return <p className="text-xs text-slate-500">No groups yet.</p>;

  const setState = async (kind: "assignment" | "quiz", id: string, action: "publish" | "close") => {
    const result = await groupApi(kind === "assignment" ? urls.assignmentState(id) : urls.quizState(id), jsonInit("PATCH", { action }));
    if (!result.ok) onError(result.message);
    onChanged();
  };

  const stateButton = (kind: "assignment" | "quiz", id: string, state: string) =>
    state === "DRAFT" ? (
      <button type="button" className={secondary} onClick={() => void setState(kind, id, "publish")}>
        Publish
      </button>
    ) : state === "PUBLISHED" ? (
      <button type="button" className={secondary} onClick={() => void setState(kind, id, "close")}>
        Close
      </button>
    ) : null;

  return (
    <ul className="space-y-3">
      {overview.rooms.map((room) => (
        <li key={room.id} className="rounded-md border border-slate-200 p-2">
          <p className="break-words text-sm font-medium">{room.name}</p>
          <p className="mb-1 break-words text-xs text-slate-600">Members: {room.members.length ? room.members.map((m) => m.name).join(", ") : "none confirmed"}</p>
          {room.assignments.length === 0 && room.quizzes.length === 0 ? <p className="text-xs text-slate-500">No group activities.</p> : null}
          <ul className="space-y-1.5">
            {room.assignments.map((a) => {
              const key = `a:${a.id}`;
              const p = a.progress;
              return (
                <li key={key} className="rounded border border-slate-100 bg-slate-50 p-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="flex min-w-0 flex-1 items-start gap-1 text-left" onClick={() => setOpen(open === key ? null : key)}>
                      {open === key ? <ChevronDown size={14} className="mt-0.5 shrink-0" /> : <ChevronRight size={14} className="mt-0.5 shrink-0" />}
                      <span className="break-words text-xs font-medium">Assignment: {a.title}</span>
                    </button>
                    {stateBadge(a.state)}
                    {stateButton("assignment", a.id, a.state)}
                  </div>
                  <p className="ml-5 break-words text-[11px] text-slate-600">
                    {p.submitted
                      ? `Submitted by ${p.submitted.submittedBy?.name ?? "—"} at ${formatTime(p.submitted.submittedAt)}`
                      : p.lastEditedBy
                        ? `Working · last edit ${p.lastEditedBy.name} at ${formatTime(p.lastEditedAt)}`
                        : "Not started"}
                  </p>
                  {open === key ? <TeacherActivityDetail sessionId={sessionId} kind="assignment" id={a.id} /> : null}
                </li>
              );
            })}
            {room.quizzes.map((q) => {
              const key = `q:${q.id}`;
              const p = q.progress;
              return (
                <li key={key} className="rounded border border-slate-100 bg-slate-50 p-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="flex min-w-0 flex-1 items-start gap-1 text-left" onClick={() => setOpen(open === key ? null : key)}>
                      {open === key ? <ChevronDown size={14} className="mt-0.5 shrink-0" /> : <ChevronRight size={14} className="mt-0.5 shrink-0" />}
                      <span className="break-words text-xs font-medium">Quiz: {q.title}</span>
                    </button>
                    {stateBadge(q.state)}
                    {stateButton("quiz", q.id, q.state)}
                  </div>
                  <p className="ml-5 break-words text-[11px] text-slate-600">
                    {!p.attemptStatus
                      ? "Not started"
                      : p.attemptStatus === "IN_PROGRESS"
                        ? `In progress · ${p.answered} / ${p.questions} answered${p.lastSavedBy ? ` · last ${p.lastSavedBy.name}` : ""}`
                        : `${p.attemptStatus === "AUTO_SUBMITTED" ? "Auto-submitted" : `Submitted by ${p.submittedBy?.name ?? "—"}`} · ${p.finalScore ?? "—"} / ${p.totalMarks ?? "—"}`}
                  </p>
                  {open === key ? <TeacherActivityDetail sessionId={sessionId} kind="quiz" id={q.id} /> : null}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}
