"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Phone, Plus, Trash2, UserRound, X } from "lucide-react";

type Guardian = {
  id: string;
  studentId: string;
  name: string;
  relation: string;
  phone: string;
  email: string | null;
  createdAt: string;
};

type FormState = {
  id: string | null;
  name: string;
  relation: string;
  phone: string;
};

const EMPTY_FORM: FormState = { id: null, name: "", relation: "", phone: "" };

function readError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const typed = payload as { error?: { message?: string }; message?: string };
  return typed.error?.message ?? typed.message ?? fallback;
}

interface StudentGuardiansProps {
  studentId: string;
  /** When provided by the parent page, the tab renders this instead of fetching. */
  guardians?: Guardian[] | null;
  /** Called after an add / edit / delete so the parent can refresh its copy. */
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

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/students/${studentId}/guardians`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: Guardian[];
      };
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
    if (controlled) {
      onChanged?.();
    } else {
      await load();
    }
  }, [controlled, onChanged, load]);

  function openAdd() {
    setForm(EMPTY_FORM);
    setIsFormOpen(true);
  }

  function openEdit(guardian: Guardian) {
    setForm({
      id: guardian.id,
      name: guardian.name,
      relation: guardian.relation,
      phone: guardian.phone,
    });
    setIsFormOpen(true);
  }

  async function save() {
    if (!form.name.trim() || !form.relation.trim() || !form.phone.trim()) {
      setError("Name, relation and phone are required.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        form.id ? `/api/guardians/${form.id}` : "/api/guardians",
        {
          method: form.id ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            form.id
              ? {
                  name: form.name.trim(),
                  relation: form.relation.trim(),
                  phone: form.phone.trim(),
                }
              : {
                  studentId,
                  name: form.name.trim(),
                  relation: form.relation.trim(),
                  phone: form.phone.trim(),
                }
          ),
        }
      );
      const payload = (await response.json()) as { success: boolean };
      if (!response.ok || payload.success === false) {
        throw new Error(readError(payload, "Failed to save guardian."));
      }
      setIsFormOpen(false);
      setForm(EMPTY_FORM);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save guardian.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this guardian?")) return;
    setDeletingId(id);
    setError(null);
    try {
      const response = await fetch(`/api/guardians/${id}`, { method: "DELETE" });
      const payload = (await response.json()) as { success: boolean };
      if (!response.ok || payload.success === false) {
        throw new Error(readError(payload, "Failed to remove guardian."));
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove guardian.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5">
        <div>
          <h3 className="text-[13px] font-semibold text-slate-900">Guardians</h3>
          <p className="text-[11px] text-slate-500">
            {guardians.length} linked{" "}
            {guardians.length === 1 ? "guardian" : "guardians"}
          </p>
        </div>
        <button
          type="button"
          onClick={openAdd}
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
          <p className="py-6 text-center text-[12px] text-slate-400">
            Loading guardians...
          </p>
        ) : guardians.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-300 py-8 text-center">
            <UserRound size={20} className="mx-auto text-slate-300" />
            <p className="mt-1.5 text-[12px] font-medium text-slate-600">
              No guardians added
            </p>
            <p className="text-[11px] text-slate-400">
              Add a parent or guardian for this student.
            </p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {guardians.map((guardian) => (
              <li
                key={guardian.id}
                className="flex items-center gap-3 rounded-md border border-slate-200 px-3 py-2"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-teal-50 text-teal-700">
                  <UserRound size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-semibold text-slate-900">
                    {guardian.name}
                    <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-500">
                      {guardian.relation}
                    </span>
                  </p>
                  <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-slate-500">
                    <Phone size={10} />
                    {guardian.phone}
                    {guardian.email ? (
                      <span className="ml-1.5 text-slate-400">
                        · {guardian.email}
                      </span>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => openEdit(guardian)}
                    title="Edit"
                    className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(guardian.id)}
                    disabled={deletingId === guardian.id}
                    title="Remove"
                    className="rounded p-1 text-rose-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {isFormOpen ? (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40"
            onClick={() => setIsFormOpen(false)}
          />
          <aside className="fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-xs flex-col border-l border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <h4 className="text-[13px] font-semibold text-slate-900">
                {form.id ? "Edit guardian" : "Add guardian"}
              </h4>
              <button
                type="button"
                onClick={() => setIsFormOpen(false)}
                className="rounded-md border border-slate-200 p-1 text-slate-500 hover:bg-slate-50"
              >
                <X size={14} />
              </button>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {error ? (
                <p className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">
                  {error}
                </p>
              ) : null}

              <GuardianField label="Name">
                <input
                  value={form.name}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, name: e.target.value }))
                  }
                  placeholder="Guardian name"
                  className="h-8 w-full rounded-md border border-slate-200 px-2 text-[12px] outline-none focus:border-teal-500"
                />
              </GuardianField>

              <GuardianField label="Relation">
                <input
                  value={form.relation}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, relation: e.target.value }))
                  }
                  placeholder="e.g. Mother, Father, Guardian"
                  className="h-8 w-full rounded-md border border-slate-200 px-2 text-[12px] outline-none focus:border-teal-500"
                />
              </GuardianField>

              <GuardianField label="Phone">
                <input
                  value={form.phone}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, phone: e.target.value }))
                  }
                  placeholder="07XXXXXXXX"
                  className="h-8 w-full rounded-md border border-slate-200 px-2 text-[12px] outline-none focus:border-teal-500"
                />
              </GuardianField>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-4 py-3">
              <button
                type="button"
                onClick={() => setIsFormOpen(false)}
                className="rounded-md px-2.5 py-1.5 text-[11px] font-semibold text-slate-500 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="rounded-md bg-teal-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
              >
                {saving ? "Saving..." : form.id ? "Update" : "Add"}
              </button>
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}

function GuardianField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold text-slate-600">
        {label}
      </label>
      {children}
    </div>
  );
}
