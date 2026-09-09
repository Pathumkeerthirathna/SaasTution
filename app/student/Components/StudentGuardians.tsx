"use client";

import { useCallback, useEffect, useState } from "react";
import { Mail, Pencil, Phone, Plus, Search, Trash2, UserRound, X } from "lucide-react";

export type Guardian = {
  linkId: string;
  guardianId: string;
  fullName: string;
  email: string;
  phone: string;
  relation: string;
  createdAt: string;
};

type SearchResult = {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  createdAt: string;
};

function readError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const typed = payload as { error?: { message?: string }; message?: string };
  return typed.error?.message ?? typed.message ?? fallback;
}

interface StudentGuardiansProps {
  studentId: string;
  guardians?: Guardian[] | null;
  onChanged?: () => void;
}

export function StudentGuardians({
  studentId,
  guardians: guardiansProp,
  onChanged,
}: StudentGuardiansProps) {
  const controlled = guardiansProp !== undefined;

  const [fetched, setFetched] = useState<Guardian[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [drawer, setDrawer] = useState<null | "add" | { edit: Guardian }>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/students/${studentId}/guardians`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as { success: boolean; data?: Guardian[] };
      if (!response.ok || !payload.success) {
        throw new Error(readError(payload, "Failed to load guardians."));
      }
      setFetched(payload.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load guardians.");
      setFetched([]);
    }
  }, [studentId]);

  useEffect(() => {
    if (controlled) return;
    void load();
  }, [controlled, load]);

  const guardians = (controlled ? guardiansProp : fetched) ?? [];
  const loading = (controlled ? guardiansProp : fetched) == null;

  const refresh = useCallback(async () => {
    if (controlled) onChanged?.();
    else await load();
  }, [controlled, onChanged, load]);

  async function unlink(guardian: Guardian) {
    if (!confirm(`Unlink ${guardian.fullName} from this student?`)) return;
    setError(null);
    try {
      const response = await fetch(
        `/api/guardians/link?guardianId=${guardian.guardianId}&studentId=${studentId}`,
        { method: "DELETE" }
      );
      const payload = (await response.json()) as { success: boolean };
      if (!response.ok || payload.success === false) {
        throw new Error(readError(payload, "Failed to unlink guardian."));
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unlink guardian.");
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5">
        <div>
          <h3 className="text-[13px] font-semibold text-slate-900">Guardians</h3>
          <p className="text-[11px] text-slate-500">
            {guardians.length} linked {guardians.length === 1 ? "guardian" : "guardians"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDrawer("add")}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-teal-600 px-2 text-[11px] font-semibold text-white transition hover:bg-teal-700"
        >
          <Plus size={12} />
          Add guardian
        </button>
      </div>

      <div className="p-3">
        {error ? (
          <p className="mb-2 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">
            {error}
          </p>
        ) : null}

        {loading ? (
          <p className="py-6 text-center text-[12px] text-slate-400">Loading guardians…</p>
        ) : guardians.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-300 py-8 text-center">
            <UserRound size={20} className="mx-auto text-slate-300" />
            <p className="mt-1.5 text-[12px] font-medium text-slate-600">No guardians linked</p>
            <p className="text-[11px] text-slate-400">
              Create a guardian account or link an existing one.
            </p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {guardians.map((guardian) => (
              <li
                key={guardian.linkId}
                className="flex items-start gap-3 rounded-md border border-slate-200 px-3 py-2"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-teal-50 text-teal-700">
                  <UserRound size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-[12px] font-semibold text-slate-900 sm:truncate">
                    {guardian.fullName}
                    <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-500">
                      {guardian.relation}
                    </span>
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                    <span className="inline-flex items-center gap-1">
                      <Phone size={10} />
                      {guardian.phone}
                    </span>
                    <span className="inline-flex items-center gap-1 break-all">
                      <Mail size={10} />
                      {guardian.email}
                    </span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => setDrawer({ edit: guardian })}
                    title="Edit"
                    className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void unlink(guardian)}
                    title="Unlink"
                    className="rounded p-1 text-rose-400 transition hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {drawer === "add" ? (
        <AddGuardianDrawer
          studentId={studentId}
          onClose={() => setDrawer(null)}
          onDone={async () => {
            setDrawer(null);
            await refresh();
          }}
        />
      ) : drawer && "edit" in drawer ? (
        <EditGuardianDrawer
          studentId={studentId}
          guardian={drawer.edit}
          onClose={() => setDrawer(null)}
          onDone={async () => {
            setDrawer(null);
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function DrawerShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-sm flex-col border-l border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h4 className="text-[13px] font-semibold text-slate-900">{title}</h4>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-200 p-1 text-slate-500 hover:bg-slate-50"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">{children}</div>
      </aside>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold text-slate-600">{label}</label>
      {children}
    </div>
  );
}

const inputClass =
  "h-8 w-full rounded-md border border-slate-200 px-2 text-[12px] outline-none focus:border-teal-500";

function AddGuardianDrawer({
  studentId,
  onClose,
  onDone,
}: {
  studentId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // existing
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [picked, setPicked] = useState<SearchResult | null>(null);
  const [existingRelation, setExistingRelation] = useState("");

  // new
  const [form, setForm] = useState({ fullName: "", email: "", phone: "", relation: "" });

  useEffect(() => {
    if (mode !== "existing" || q.trim().length < 1) {
      setResults([]);
      return;
    }
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/guardians/search?q=${encodeURIComponent(q.trim())}`, {
          cache: "no-store",
        });
        const payload = (await res.json()) as { success: boolean; data?: SearchResult[] };
        if (payload.success) setResults(payload.data ?? []);
      } catch {
        /* ignore */
      }
    }, 250);
    return () => clearTimeout(id);
  }, [q, mode]);

  async function linkExisting() {
    if (!picked || !existingRelation.trim()) {
      setError("Pick a guardian and enter the relation.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/guardians/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guardianId: picked.id,
          studentId,
          relation: existingRelation.trim(),
        }),
      });
      const payload = (await res.json()) as { success: boolean };
      if (!res.ok || payload.success === false) {
        throw new Error(readError(payload, "Failed to link guardian."));
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to link guardian.");
    } finally {
      setSaving(false);
    }
  }

  async function createNew() {
    if (!form.fullName.trim() || !form.email.trim() || !form.phone.trim() || !form.relation.trim()) {
      setError("Full name, email, phone and relation are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/guardians", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId,
          fullName: form.fullName.trim(),
          email: form.email.trim(),
          phone: form.phone.trim(),
          relation: form.relation.trim(),
        }),
      });
      const payload = (await res.json()) as { success: boolean };
      if (!res.ok || payload.success === false) {
        throw new Error(readError(payload, "Failed to create guardian."));
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create guardian.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <DrawerShell title="Add guardian" onClose={onClose}>
      <div className="flex rounded-md border border-slate-200 p-0.5 text-[11px] font-semibold">
        <button
          type="button"
          onClick={() => setMode("existing")}
          className={`flex-1 rounded px-2 py-1 ${
            mode === "existing" ? "bg-teal-600 text-white" : "text-slate-500"
          }`}
        >
          Find existing
        </button>
        <button
          type="button"
          onClick={() => setMode("new")}
          className={`flex-1 rounded px-2 py-1 ${
            mode === "new" ? "bg-teal-600 text-white" : "text-slate-500"
          }`}
        >
          Create new
        </button>
      </div>

      {error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">
          {error}
        </p>
      ) : null}

      {mode === "existing" ? (
        <>
          <Field label="Search by name or email">
            <div className="relative">
              <Search
                size={13}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPicked(null);
                }}
                placeholder="e.g. Nimal or nimal@mail.com"
                className={`${inputClass} pl-7`}
              />
            </div>
          </Field>

          {picked ? (
            <div className="rounded-md border border-teal-300 bg-teal-50 px-2.5 py-2">
              <p className="text-[12px] font-semibold text-slate-900">{picked.fullName}</p>
              <p className="text-[11px] text-slate-500">{picked.email}</p>
              <button
                type="button"
                onClick={() => setPicked(null)}
                className="mt-1 text-[11px] font-medium text-teal-700 hover:underline"
              >
                Choose a different guardian
              </button>
            </div>
          ) : results.length > 0 ? (
            <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(r)}
                    className="block w-full px-2.5 py-1.5 text-left hover:bg-slate-50"
                  >
                    <span className="block text-[12px] font-medium text-slate-800">
                      {r.fullName}
                    </span>
                    <span className="block text-[11px] text-slate-500">{r.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : q.trim() ? (
            <p className="text-[11px] text-slate-400">No matching guardians.</p>
          ) : null}

          <Field label="Relation to this student">
            <input
              value={existingRelation}
              onChange={(e) => setExistingRelation(e.target.value)}
              placeholder="e.g. Mother, Father, Guardian"
              className={inputClass}
            />
          </Field>

          <button
            type="button"
            onClick={() => void linkExisting()}
            disabled={saving}
            className="w-full rounded-md bg-teal-600 py-1.5 text-[11px] font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
          >
            {saving ? "Linking…" : "Link guardian"}
          </button>
        </>
      ) : (
        <>
          <Field label="Full name">
            <input
              value={form.fullName}
              onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
              className={inputClass}
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              className={inputClass}
            />
          </Field>
          <Field label="Phone">
            <input
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              className={inputClass}
            />
          </Field>
          <Field label="Relation to this student">
            <input
              value={form.relation}
              onChange={(e) => setForm((f) => ({ ...f, relation: e.target.value }))}
              placeholder="e.g. Mother, Father, Guardian"
              className={inputClass}
            />
          </Field>
          <p className="rounded-md bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500">
            A password is generated and emailed to the guardian. They sign in with
            their email at <span className="font-medium">/guardian/login</span>.
          </p>
          <button
            type="button"
            onClick={() => void createNew()}
            disabled={saving}
            className="w-full rounded-md bg-teal-600 py-1.5 text-[11px] font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
          >
            {saving ? "Creating…" : "Create & email credentials"}
          </button>
        </>
      )}
    </DrawerShell>
  );
}

function EditGuardianDrawer({
  studentId,
  guardian,
  onClose,
  onDone,
}: {
  studentId: string;
  guardian: Guardian;
  onClose: () => void;
  onDone: () => void;
}) {
  const [relation, setRelation] = useState(guardian.relation);
  const [form, setForm] = useState({
    fullName: guardian.fullName,
    email: guardian.email,
    phone: guardian.phone,
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (relation.trim() !== guardian.relation) {
        const res = await fetch(`/api/guardians/${guardian.guardianId}/relation`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ studentId, relation: relation.trim() }),
        });
        const payload = (await res.json()) as { success: boolean };
        if (!res.ok || payload.success === false) {
          throw new Error(readError(payload, "Failed to update relation."));
        }
      }

      const detailsChanged =
        form.fullName.trim() !== guardian.fullName ||
        form.email.trim() !== guardian.email ||
        form.phone.trim() !== guardian.phone;

      if (detailsChanged) {
        const res = await fetch(`/api/guardians/${guardian.guardianId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fullName: form.fullName.trim(),
            email: form.email.trim(),
            phone: form.phone.trim(),
          }),
        });
        const payload = (await res.json()) as { success: boolean };
        if (!res.ok || payload.success === false) {
          throw new Error(readError(payload, "Failed to update guardian."));
        }
      }

      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <DrawerShell title="Edit guardian" onClose={onClose}>
      {error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">
          {error}
        </p>
      ) : null}

      <Field label="Relation to this student">
        <input
          value={relation}
          onChange={(e) => setRelation(e.target.value)}
          className={inputClass}
        />
      </Field>

      <p className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Shared account details
      </p>
      <Field label="Full name">
        <input
          value={form.fullName}
          onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
          className={inputClass}
        />
      </Field>
      <Field label="Email">
        <input
          type="email"
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          className={inputClass}
        />
      </Field>
      <Field label="Phone">
        <input
          value={form.phone}
          onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          className={inputClass}
        />
      </Field>
      <p className="rounded-md bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500">
        Editing the name, email or phone changes them everywhere this guardian is
        linked.
      </p>

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="w-full rounded-md bg-teal-600 py-1.5 text-[11px] font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
      >
        {saving ? "Saving…" : "Save changes"}
      </button>
    </DrawerShell>
  );
}
