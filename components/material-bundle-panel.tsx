"use client";

import { useEffect, useState } from "react";
import {
  BookOpen,
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Files,
  Eye,
  GraduationCap,
  Pencil,
  Plus,
  Trash2,
  Users,
  X,
} from "lucide-react";
import toast from "react-hot-toast";

type ClassItem = {
  id: string;
  name: string;
};

type BundleListItem = {
  id: string;
  classId: string;
  title: string;
  year: number;
  month: number;
  bundleStatus: "DRAFT" | "SENT";
  sentAt: string | null;
  createdAt: string;
  class: ClassItem;
  _count: {
    items: number;
    recipients: number;
  };
};

type BundleItem = {
  id: string;
  type: "TUTE" | "PAPER";
  title: string;
  description: string | null;
  fileName: string | null;
  fileUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  paperStartAt: string | null;
  paperEndAt: string | null;
  createdAt: string;
};

type BundleStudentOption = {
  id: string;
  name: string;
  registrationNumber: string | null;
};

type WzPendingItem = {
  localId: string;
  type: "TUTE" | "PAPER";
  title: string;
  description: string;
  file: File | null;
  paperStartAt: string;
  paperEndAt: string;
};

type BundleStudent = {
  id: string;
  name: string;
  registrationNumber: string | null;
  willReceive: boolean;
  receivedAt: string | null;
};

type Pagination = {
  page: number;
  totalPages: number;
};

type ApiError = {
  error?: {
    message?: string;
  };
  message?: string;
};




function readApiError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const typed = payload as ApiError;
  return typed.error?.message ?? typed.message ?? fallback;
}

function monthLabel(month: number) {
  return new Date(2000, month - 1, 1).toLocaleString("en-US", { month: "long" });
}

function toLocalInput(value: string | null) {
  if (!value) return "";
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function isImageItem(item: { mimeType: string | null; fileName: string | null }) {
  return (
    (item.mimeType ?? "").startsWith("image/") ||
    /\.(png|jpe?g|webp|gif)$/i.test(item.fileName ?? "")
  );
}

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];


function AccordionItemForm({
  type,
  mode,
  title,
  desc,
  start,
  end,
  saving,
  currentFileName,
  onTitle,
  onDesc,
  onFile,
  onStart,
  onEnd,
  onSubmit,
  onCancel,
}: {
  type: "TUTE" | "PAPER";
  mode: "add" | "edit";
  title: string;
  desc: string;
  start: string;
  end: string;
  saving: boolean;
  currentFileName?: string | null;
  onTitle: (v: string) => void;
  onDesc: (v: string) => void;
  onFile: (f: File | null) => void;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-1.5" onClick={(e) => e.stopPropagation()}>
      <input
        value={title}
        onChange={(e) => onTitle(e.target.value)}
        placeholder="Title"
        maxLength={150}
        className="control-input h-8 text-[12px]"
      />
      <textarea
        value={desc}
        onChange={(e) => onDesc(e.target.value)}
        rows={2}
        placeholder="Description (optional)"
        className="control-textarea text-[12px]"
      />
      <div className="space-y-0.5">
        {mode === "edit" ? (
          <p className="text-[10px] text-slate-400">
            {currentFileName
              ? `Current file: ${currentFileName}. Choose a new file to replace it.`
              : "No file attached. Choose a PDF or image to add one."}
          </p>
        ) : null}
        <input
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp,image/gif"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          className="block w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] file:mr-2 file:rounded file:border-0 file:bg-teal-50 file:px-1.5 file:py-0.5 file:text-[10px] file:font-semibold file:text-teal-700"
        />
      </div>
      {type === "PAPER" ? (
        <div className="grid grid-cols-2 gap-1.5">
          <label className="block space-y-0.5 text-[10px] font-medium text-slate-500">
            Start
            <input
              type="datetime-local"
              value={start}
              onChange={(e) => onStart(e.target.value)}
              className="control-input h-8 text-[11px]"
            />
          </label>
          <label className="block space-y-0.5 text-[10px] font-medium text-slate-500">
            End
            <input
              type="datetime-local"
              value={end}
              onChange={(e) => onEnd(e.target.value)}
              className="control-input h-8 text-[11px]"
            />
          </label>
        </div>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="btn-ghost h-7 px-2 text-[10px]">
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={saving}
          className="btn-primary h-7 px-2 text-[10px] disabled:opacity-60"
        >
          {saving ? "Saving..." : mode === "add" ? "Add" : "Save"}
        </button>
      </div>
    </div>
  );
}

export function MaterialBundlePanel() {
  const now = new Date();

  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [bundles, setBundles] = useState<BundleListItem[]>([]);

  const [filterClassId, setFilterClassId] = useState("");
  const [filterYear, setFilterYear] = useState("");
  const [filterMonth, setFilterMonth] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);

  // ── "Add class bundle" wizard ──────────────────────────────────────────
  const [isWizardOpen, setIsWizardOpen] = useState(false);

  const [wzClassId, setWzClassId] = useState("");
  const [wzTitle, setWzTitle] = useState("");
  const [wzYear, setWzYear] = useState(String(now.getFullYear()));
  const [wzMonth, setWzMonth] = useState(String(now.getMonth() + 1));

  const [wzPending, setWzPending] = useState<WzPendingItem[]>([]);
  const [wzPopover, setWzPopover] = useState<null | "TUTE" | "PAPER">(null);
  const [wzEditId, setWzEditId] = useState<string | null>(null);
  const [wzItemTitle, setWzItemTitle] = useState("");
  const [wzItemDescription, setWzItemDescription] = useState("");
  const [wzItemFile, setWzItemFile] = useState<File | null>(null);
  const [wzPaperStart, setWzPaperStart] = useState("");
  const [wzPaperEnd, setWzPaperEnd] = useState("");

  const [wzStudents, setWzStudents] = useState<BundleStudentOption[]>([]);
  const [wzStudentSel, setWzStudentSel] = useState<Record<string, boolean>>({});
  const [wzLoadingStudents, setWzLoadingStudents] = useState(false);
  const [wzSaving, setWzSaving] = useState(false);


  const [statusMenuBundleId, setStatusMenuBundleId] = useState<string | null>(null);
  const [expandedBundleId, setExpandedBundleId] = useState<string | null>(null);
  const [expandedView, setExpandedView] = useState<"items" | "students">("items");
  const [expandedTab, setExpandedTab] = useState<"TUTE" | "PAPER">("TUTE");
  const [bundleItemsCache, setBundleItemsCache] = useState<Record<string, BundleItem[]>>({});
  const [bundleStudentsCache, setBundleStudentsCache] = useState<
    Record<string, { students: BundleStudent[]; hasRecipientSelections: boolean }>
  >({});
  const [studentSel, setStudentSel] = useState<Record<string, boolean>>({});
  const [savingRecipients, setSavingRecipients] = useState(false);
  const [loadingItemsBundleId, setLoadingItemsBundleId] = useState<string | null>(null);

  const [accForm, setAccForm] = useState<
    | null
    | { mode: "add"; type: "TUTE" | "PAPER" }
    | { mode: "edit"; itemId: string; type: "TUTE" | "PAPER" }
  >(null);
  const [accTitle, setAccTitle] = useState("");
  const [accDesc, setAccDesc] = useState("");
  const [accFile, setAccFile] = useState<File | null>(null);
  const [accStart, setAccStart] = useState("");
  const [accEnd, setAccEnd] = useState("");
  const [accSaving, setAccSaving] = useState(false);

  const [viewerItem, setViewerItem] = useState<
    | null
    | {
        bundleId: string;
        itemId: string;
        title: string;
        kind: "pdf" | "image";
      }
  >(null);

  const currentYear = now.getFullYear();
  const yearOptions = Array.from({ length: 6 }, (_, index) => currentYear - index);

  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    async function loadClasses() {
      const response = await fetch("/api/classes?page=1&pageSize=100", { cache: "no-store" });
      const payload = (await response.json()) as {
        success: boolean;
        data?: ClassItem[];
      };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to load classes."));
      }

      setClasses(payload.data ?? []);
    }

    void loadClasses().catch((error) => {
      toast.error(error instanceof Error ? error.message : "Failed to load classes.");
    });
  }, []);


  async function loadBundles(nextPage = page) {
    setIsLoading(true);

    try {
      const qs = new URLSearchParams({
        page: String(nextPage),
        pageSize: "4",
      });

      if (filterClassId) qs.set("classId", filterClassId);
      if (filterYear.trim()) qs.set("year", filterYear.trim());
      if (filterMonth.trim()) qs.set("month", filterMonth.trim());

      const response = await fetch(`/api/material-bundles?${qs.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as {
        success: boolean;
        data?: BundleListItem[];
        pagination?: Pagination;
      };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to load bundles."));
      }

      const list = payload.data ?? [];
      setBundles(list);
      setPage(nextPage);
      setTotalPages(payload.pagination?.totalPages ?? 1);

      const stillSelected = selectedBundleId && list.some((b) => b.id === selectedBundleId);
      if (!stillSelected) {
        setSelectedBundleId(list[0]?.id ?? null);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load bundles.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadBundles(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterClassId, filterYear, filterMonth]);

  async function deleteBundle(bundleId: string, title: string) {
    const confirmed = window.confirm(
      `Delete the bundle "${title}"?\n\nIt will be removed from your list and from students' portals. Its files and records are kept.`
    );
    if (!confirmed) return;

    try {
      const response = await fetch(`/api/material-bundles/${bundleId}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { success: boolean };
      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to delete bundle."));
      }

      setBundles((prev) => prev.filter((b) => b.id !== bundleId));
      setBundleItemsCache((prev) => {
        const next = { ...prev };
        delete next[bundleId];
        return next;
      });
      setBundleStudentsCache((prev) => {
        const next = { ...prev };
        delete next[bundleId];
        return next;
      });
      if (expandedBundleId === bundleId) setExpandedBundleId(null);
      if (selectedBundleId === bundleId) setSelectedBundleId(null);
      if (statusMenuBundleId === bundleId) setStatusMenuBundleId(null);

      toast.success("Bundle deleted.");
      void loadBundles(page);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete bundle.");
    }
  }

  async function updateBundleStatus(bundleId: string, bundleStatus: "DRAFT" | "SENT") {
    setStatusMenuBundleId(null);

    try {
      const response = await fetch(`/api/material-bundles/${bundleId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundleStatus }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: { bundle: { bundleStatus: "DRAFT" | "SENT"; sentAt: string | null } };
      };

      if (!response.ok || !payload.success || !payload.data?.bundle) {
        throw new Error(readApiError(payload, "Failed to update status."));
      }

      const updated = payload.data.bundle;
      setBundles((prev) =>
        prev.map((b) =>
          b.id === bundleId ? { ...b, bundleStatus: updated.bundleStatus, sentAt: updated.sentAt } : b
        )
      );
      toast.success(`Bundle marked as ${bundleStatus}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update status.");
    }
  }

  function accResetForm() {
    setAccForm(null);
    setAccTitle("");
    setAccDesc("");
    setAccFile(null);
    setAccStart("");
    setAccEnd("");
  }

  function accOpenAdd(type: "TUTE" | "PAPER") {
    accResetForm();
    setAccForm({ mode: "add", type });
  }

  function accOpenEdit(item: BundleItem) {
    setAccForm({ mode: "edit", itemId: item.id, type: item.type });
    setAccTitle(item.title);
    setAccDesc(item.description ?? "");
    setAccFile(null);
    setAccStart(toLocalInput(item.paperStartAt));
    setAccEnd(toLocalInput(item.paperEndAt));
  }

  async function accSubmitForm(bundleId: string) {
    if (!accForm) return;

    if (accTitle.trim().length < 2) {
      toast.error("Item title is required (at least 2 characters).");
      return;
    }
    if (
      accForm.type === "PAPER" &&
      accForm.mode === "add" &&
      (!accStart || !accEnd)
    ) {
      toast.error("Paper start and end time are required.");
      return;
    }

    setAccSaving(true);
    try {
      if (accForm.mode === "add") {
        const formData = new FormData();
        formData.set("type", accForm.type);
        formData.set("title", accTitle.trim());
        if (accDesc.trim()) formData.set("description", accDesc.trim());
        if (accForm.type === "PAPER") {
          formData.set("paperStartAt", accStart);
          formData.set("paperEndAt", accEnd);
        }
        if (accFile) formData.set("file", accFile);

        const response = await fetch(`/api/material-bundles/${bundleId}/items`, {
          method: "POST",
          body: formData,
        });
        const payload = (await response.json()) as {
          success: boolean;
          data?: { item: BundleItem };
        };
        if (!response.ok || !payload.success || !payload.data?.item) {
          throw new Error(readApiError(payload, "Failed to add item."));
        }
        const item = payload.data.item;
        setBundleItemsCache((prev) => ({
          ...prev,
          [bundleId]: [...(prev[bundleId] ?? []), item],
        }));
        toast.success("Item added.");
      } else {
        const formData = new FormData();
        formData.set("title", accTitle.trim());
        formData.set("description", accDesc.trim());
        if (accForm.type === "PAPER") {
          if (accStart) formData.set("paperStartAt", new Date(accStart).toISOString());
          if (accEnd) formData.set("paperEndAt", new Date(accEnd).toISOString());
        }
        if (accFile) formData.set("file", accFile);

        const response = await fetch(
          `/api/material-bundles/${bundleId}/items/${accForm.itemId}`,
          {
            method: "PUT",
            body: formData,
          }
        );
        const payload = (await response.json()) as {
          success: boolean;
          data?: { item: BundleItem };
        };
        if (!response.ok || !payload.success || !payload.data?.item) {
          throw new Error(readApiError(payload, "Failed to update item."));
        }
        const updated = payload.data.item;
        setBundleItemsCache((prev) => ({
          ...prev,
          [bundleId]: (prev[bundleId] ?? []).map((i) =>
            i.id === updated.id ? updated : i
          ),
        }));
        toast.success("Item updated.");
      }
      accResetForm();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save item.");
    } finally {
      setAccSaving(false);
    }
  }

  async function accDeleteItem(bundleId: string, itemId: string) {
    if (!window.confirm("Remove this item from the bundle?")) return;

    try {
      const response = await fetch(
        `/api/material-bundles/${bundleId}/items/${itemId}`,
        { method: "DELETE" }
      );
      const payload = (await response.json()) as { success: boolean };
      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to remove item."));
      }
      setBundleItemsCache((prev) => ({
        ...prev,
        [bundleId]: (prev[bundleId] ?? []).filter((i) => i.id !== itemId),
      }));
      if (accForm?.mode === "edit" && accForm.itemId === itemId) accResetForm();
      toast.success("Item removed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove item.");
    }
  }

  function initStudentSel(entry: {
    students: BundleStudent[];
    hasRecipientSelections: boolean;
  }) {
    const sel: Record<string, boolean> = {};
    for (const student of entry.students) {
      sel[student.id] = entry.hasRecipientSelections ? student.willReceive : true;
    }
    setStudentSel(sel);
  }

  async function toggleBundleAccordion(bundleId: string, view: "items" | "students") {
    accResetForm();

    if (expandedBundleId === bundleId && expandedView === view) {
      setExpandedBundleId(null);
      return;
    }

    setExpandedBundleId(bundleId);
    setExpandedView(view);
    if (view === "items") setExpandedTab("TUTE");

    const cachedStudents = bundleStudentsCache[bundleId];
    if (bundleItemsCache[bundleId] && cachedStudents) {
      if (view === "students") initStudentSel(cachedStudents);
      return;
    }

    setLoadingItemsBundleId(bundleId);
    try {
      const response = await fetch(`/api/material-bundles/${bundleId}`, { cache: "no-store" });
      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          bundle: {
            items: BundleItem[];
            students: BundleStudent[];
            hasRecipientSelections: boolean;
          };
        };
      };

      if (!response.ok || !payload.success || !payload.data?.bundle) {
        throw new Error(readApiError(payload, "Failed to load bundle details."));
      }

      const b = payload.data.bundle;
      setBundleItemsCache((prev) => ({ ...prev, [bundleId]: b.items }));
      const studentsEntry = {
        students: b.students,
        hasRecipientSelections: b.hasRecipientSelections,
      };
      setBundleStudentsCache((prev) => ({ ...prev, [bundleId]: studentsEntry }));
      if (view === "students") initStudentSel(studentsEntry);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load bundle details.");
      setExpandedBundleId((current) => (current === bundleId ? null : current));
    } finally {
      setLoadingItemsBundleId(null);
    }
  }

  async function saveRecipients(bundleId: string) {
    setSavingRecipients(true);
    try {
      const selectedStudentIds = Object.entries(studentSel)
        .filter(([, selected]) => selected)
        .map(([id]) => id);

      const response = await fetch(`/api/material-bundles/${bundleId}/recipients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedStudentIds }),
      });
      const payload = (await response.json()) as { success: boolean };
      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to update recipients."));
      }

      setBundles((prev) =>
        prev.map((b) =>
          b.id === bundleId
            ? {
                ...b,
                bundleStatus: "SENT",
                sentAt: new Date().toISOString(),
                _count: { ...b._count, recipients: selectedStudentIds.length },
              }
            : b
        )
      );
      setBundleStudentsCache((prev) => {
        const entry = prev[bundleId];
        if (!entry) return prev;
        return {
          ...prev,
          [bundleId]: {
            hasRecipientSelections: true,
            students: entry.students.map((s) => ({
              ...s,
              willReceive: studentSel[s.id] ?? false,
            })),
          },
        };
      });
      toast.success("Recipients updated and bundle sent.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update recipients.");
    } finally {
      setSavingRecipients(false);
    }
  }

  function openWizard() {
    setWzClassId(classes[0]?.id ?? "");
    setWzTitle("");
    setWzYear(String(now.getFullYear()));
    setWzMonth(String(now.getMonth() + 1));
    setWzPending([]);
    wizardResetItemForm();
    setWzStudents([]);
    setWzStudentSel({});
    setIsWizardOpen(true);
  }

  function wizardResetItemForm() {
    setWzPopover(null);
    setWzEditId(null);
    setWzItemTitle("");
    setWzItemDescription("");
    setWzItemFile(null);
    setWzPaperStart("");
    setWzPaperEnd("");
  }

  function wizardOpenItemForm(type: "TUTE" | "PAPER") {
    if (wzPopover === type && !wzEditId) {
      wizardResetItemForm();
      return;
    }
    setWzEditId(null);
    setWzItemTitle("");
    setWzItemDescription("");
    setWzItemFile(null);
    setWzPaperStart("");
    setWzPaperEnd("");
    setWzPopover(type);
  }

  function wizardEditPendingItem(item: WzPendingItem) {
    setWzEditId(item.localId);
    setWzPopover(item.type);
    setWzItemTitle(item.title);
    setWzItemDescription(item.description);
    setWzItemFile(item.file);
    setWzPaperStart(item.paperStartAt);
    setWzPaperEnd(item.paperEndAt);
  }

  function wizardSavePendingItem() {
    if (!wzPopover) return;

    if (wzItemTitle.trim().length < 2) {
      toast.error("Item title is required (at least 2 characters).");
      return;
    }
    if (wzPopover === "PAPER" && (!wzPaperStart || !wzPaperEnd)) {
      toast.error("Paper start and end time are required.");
      return;
    }


    const entry: WzPendingItem = {
      localId: wzEditId ?? crypto.randomUUID(),
      type: wzPopover,
      title: wzItemTitle.trim(),
      description: wzItemDescription.trim(),
      file: wzItemFile,
      paperStartAt: wzPopover === "PAPER" ? wzPaperStart : "",
      paperEndAt: wzPopover === "PAPER" ? wzPaperEnd : "",
    };

    setWzPending((prev) =>
      wzEditId
        ? prev.map((item) => (item.localId === wzEditId ? entry : item))
        : [...prev, entry]
    );
    wizardResetItemForm();
  }

  function wizardRemovePendingItem(localId: string) {
    setWzPending((prev) => prev.filter((item) => item.localId !== localId));
    if (wzEditId === localId) wizardResetItemForm();
  }

  // Load the active class students (ClassStudent, active in the selected month)
  // whenever the wizard is open and the class / period changes. All start selected.
  useEffect(() => {
    if (!isWizardOpen || !wzClassId) {
      setWzStudents([]);
      setWzStudentSel({});
      return;
    }

    let cancelled = false;
    setWzLoadingStudents(true);

    const qs = new URLSearchParams({
      classId: wzClassId,
      year: wzYear,
      month: wzMonth,
    });

    fetch(`/api/material-bundles/class-students?${qs.toString()}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: { success: boolean; data?: { students: BundleStudentOption[] } }) => {
        if (cancelled) return;
        if (!payload.success) {
          throw new Error(readApiError(payload, "Failed to load class students."));
        }
        const list = payload.data?.students ?? [];
        setWzStudents(list);
        setWzStudentSel(Object.fromEntries(list.map((student) => [student.id, true])));
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : "Failed to load class students.");
        }
      })
      .finally(() => {
        if (!cancelled) setWzLoadingStudents(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isWizardOpen, wzClassId, wzYear, wzMonth]);

  async function wizardSubmit() {
    if (!wzClassId) {
      toast.error("Select a class.");
      return;
    }
    if (wzTitle.trim().length < 2) {
      toast.error("Bundle title must be at least 2 characters.");
      return;
    }

    setWzSaving(true);

    try {
      // 1. Create the bundle.
      const response = await fetch("/api/material-bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classId: wzClassId,
          title: wzTitle.trim(),
          year: Number(wzYear),
          month: Number(wzMonth),
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: { bundle: { id: string } };
      };

      if (!response.ok || !payload.success || !payload.data?.bundle?.id) {
        throw new Error(readApiError(payload, "Failed to create bundle."));
      }

      const bundleId = payload.data.bundle.id;

      // 2. Upload each tute / paper as a material bundle item.
      let failed = 0;
      for (const item of wzPending) {
        const formData = new FormData();
        formData.set("type", item.type);
        formData.set("title", item.title);
        if (item.description) formData.set("description", item.description);
        if (item.type === "PAPER") {
          formData.set("paperStartAt", item.paperStartAt);
          formData.set("paperEndAt", item.paperEndAt);
        }
        if (item.file) formData.set("file", item.file);

        const itemResponse = await fetch(`/api/material-bundles/${bundleId}/items`, {
          method: "POST",
          body: formData,
        });
        const itemPayload = (await itemResponse.json()) as { success: boolean };
        if (!itemResponse.ok || !itemPayload.success) failed += 1;
      }

      // 3. Add the selected active students as MaterialBundleRecipient rows.
      const selectedStudentIds = Object.entries(wzStudentSel)
        .filter(([, selected]) => selected)
        .map(([id]) => id);

      const recipientsResponse = await fetch(
        `/api/material-bundles/${bundleId}/recipients`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selectedStudentIds }),
        }
      );
      const recipientsPayload = (await recipientsResponse.json()) as { success: boolean };
      if (!recipientsResponse.ok || !recipientsPayload.success) {
        throw new Error(readApiError(recipientsPayload, "Failed to save recipients."));
      }

      setIsWizardOpen(false);
      toast.success(
        failed > 0
          ? `Bundle created and sent, but ${failed} item(s) failed to upload.`
          : "Bundle created and sent to the selected students."
      );
      await loadBundles(1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create bundle.");
    } finally {
      setWzSaving(false);
    }
  }

  const wzMonthLabel = `${monthLabel(Number(wzMonth))} ${wzYear}`;
  const wzSelectedCount = Object.values(wzStudentSel).filter(Boolean).length;

  return (
    <div className="px-0 py-1 sm:py-0">


      <div className="grid gap-3 xl:grid-cols-[340px_minmax(0,1fr)] 2xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="self-start xl:sticky xl:top-4 xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto scrollbar-thin">
          {/* Filters — class / year / month tile pickers */}
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              {/* Class */}
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Class</p>
                <div className="scrollbar-thin max-h-[220px] space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-1.5">
                  <button
                    type="button"
                    onClick={() => setFilterClassId("")}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold transition ${
                      filterClassId === ""
                        ? "bg-teal-600 text-white shadow-sm"
                        : "bg-white text-slate-600 hover:bg-teal-50"
                    }`}
                  >
                    <BookOpen size={12} className={filterClassId === "" ? "text-white" : "text-slate-400"} />
                    <span className="truncate">All classes</span>
                  </button>
                  {classes.map((item) => {
                    const selected = item.id === filterClassId;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setFilterClassId(item.id)}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold transition ${
                          selected
                            ? "bg-teal-600 text-white shadow-sm"
                            : "bg-white text-slate-600 hover:bg-teal-50"
                        }`}
                      >
                        <BookOpen size={12} className={selected ? "text-white" : "text-slate-400"} />
                        <span className="truncate">{item.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Year */}
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Year</p>
                <div className="grid grid-cols-3 gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-1.5">
                  <button
                    type="button"
                    onClick={() => setFilterYear("")}
                    className={`rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                      filterYear === ""
                        ? "bg-teal-600 text-white shadow-sm"
                        : "bg-white text-slate-600 hover:bg-teal-50"
                    }`}
                  >
                    All
                  </button>
                  {yearOptions.map((option) => {
                    const selected = filterYear === String(option);
                    return (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setFilterYear(String(option))}
                        className={`rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                          selected
                            ? "bg-teal-600 text-white shadow-sm"
                            : "bg-white text-slate-600 hover:bg-teal-50"
                        }`}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Month — 4 per row */}
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Month</p>
                <div className="grid grid-cols-4 gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-1.5">
                  <button
                    type="button"
                    onClick={() => setFilterMonth("")}
                    className={`col-span-4 rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                      filterMonth === ""
                        ? "bg-teal-600 text-white shadow-sm"
                        : "bg-white text-slate-600 hover:bg-teal-50"
                    }`}
                  >
                    All months
                  </button>
                  {MONTHS_SHORT.map((label, index) => {
                    const value = index + 1;
                    const selected = filterMonth === String(value);
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => setFilterMonth(String(value))}
                        className={`rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                          selected
                            ? "bg-teal-600 text-white shadow-sm"
                            : "bg-white text-slate-600 hover:bg-teal-50"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

        </aside>

        <div className="self-start">
          {/* Bundle list */}
          <section className="flex flex-col rounded-xl border border-slate-200 bg-white p-3 shadow-sm xl:h-[calc(100vh-6rem)]">
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Bundle List</p>
              <div className="flex items-center gap-2">
                <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-teal-100 px-2 text-[11px] font-semibold text-teal-700">
                  {bundles.length}
                </span>
                <button
                  type="button"
                  onClick={openWizard}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-teal-600 px-3 text-xs font-semibold text-white transition hover:bg-teal-700"
                >
                  <Plus size={14} />
                  New bundle
                </button>
              </div>
            </div>
            {isLoading ? <p className="px-1 pb-2 text-xs font-medium text-slate-400">Loading...</p> : null}
            <div className="scrollbar-thin grid flex-1 auto-rows-min gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
              {bundles.map((bundle) => {
                const selected = selectedBundleId === bundle.id;
                const expanded = expandedBundleId === bundle.id;
                const accItems = bundleItemsCache[bundle.id] ?? [];
                const accTutes = accItems.filter((it) => it.type === "TUTE");
                const accPapers = accItems.filter((it) => it.type === "PAPER");
                const accList = expandedTab === "TUTE" ? accTutes : accPapers;
                const accStudentsEntry = bundleStudentsCache[bundle.id];
                const accStudents = accStudentsEntry?.students ?? [];
                const recipientsEditable = bundle.bundleStatus !== "SENT";
                const accSelCount = accStudents.filter((st) => studentSel[st.id]).length;
                return (
                  <div
                    key={bundle.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedBundleId(bundle.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedBundleId(bundle.id);
                      }
                    }}
                    className={`h-fit cursor-pointer rounded-lg px-3 py-2.5 text-left transition ${
                      selected
                        ? "bg-teal-50 ring-1 ring-teal-300"
                        : "bg-slate-50 hover:bg-teal-50/60"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white ${
                          selected ? "text-teal-700" : "text-slate-500"
                        }`}
                      >
                        <FileText size={14} />
                      </span>
                      <p className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-900">
                        {bundle.title}
                      </p>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteBundle(bundle.id, bundle.title);
                        }}
                        title="Delete bundle"
                        aria-label="Delete bundle"
                        className="shrink-0 rounded-md p-1 text-slate-300 transition hover:bg-rose-50 hover:text-rose-600"
                      >
                        <Trash2 size={12} />
                      </button>

                      <div className="relative shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setStatusMenuBundleId((cur) => (cur === bundle.id ? null : bundle.id));
                          }}
                          title="Change status"
                          className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] transition ${
                            bundle.bundleStatus === "SENT"
                              ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                              : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                          }`}
                        >
                          {bundle.bundleStatus}
                          <ChevronDown size={9} />
                        </button>
                        {statusMenuBundleId === bundle.id ? (
                          <>
                            <div
                              className="fixed inset-0 z-10"
                              onClick={(e) => {
                                e.stopPropagation();
                                setStatusMenuBundleId(null);
                              }}
                            />
                            <div
                              className="absolute right-0 z-20 mt-1 w-36 rounded-lg border border-slate-200 bg-white p-1 shadow-lg"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {(["DRAFT", "SENT"] as const).map((st) => (
                                <button
                                  key={st}
                                  type="button"
                                  disabled={st === bundle.bundleStatus}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void updateBundleStatus(bundle.id, st);
                                  }}
                                  className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-semibold transition ${
                                    st === bundle.bundleStatus
                                      ? "cursor-default bg-slate-50 text-slate-400"
                                      : "text-slate-700 hover:bg-teal-50"
                                  }`}
                                >
                                  <span
                                    className={`h-1.5 w-1.5 rounded-full ${
                                      st === "SENT" ? "bg-emerald-500" : "bg-slate-400"
                                    }`}
                                  />
                                  {st === bundle.bundleStatus ? `${st} (current)` : `Mark as ${st}`}
                                </button>
                              ))}
                            </div>
                          </>
                        ) : null}
                      </div>
                    </div>

                    <p className="mt-1.5 text-[12px] font-medium text-slate-500">
                      {monthLabel(bundle.month)} {bundle.year}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      Created {new Date(bundle.createdAt).toLocaleDateString()}
                    </p>

                    <div className="mt-1.5 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggleBundleAccordion(bundle.id, "students");
                        }}
                        className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold transition ${
                          expanded && expandedView === "students"
                            ? "bg-slate-200 text-slate-700"
                            : "text-slate-500 hover:bg-slate-100"
                        }`}
                      >
                        Student list
                        <ChevronRight
                          size={11}
                          className={`transition-transform ${
                            expanded && expandedView === "students" ? "rotate-90" : ""
                          }`}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggleBundleAccordion(bundle.id, "items");
                        }}
                        className="inline-flex items-center gap-0.5 rounded-md bg-teal-600 px-2 py-0.5 text-[10px] font-semibold text-white transition hover:bg-teal-700"
                      >
                        View more
                        <ChevronRight
                          size={11}
                          className={`transition-transform ${
                            expanded && expandedView === "items" ? "rotate-90" : ""
                          }`}
                        />
                      </button>
                    </div>

                    {expanded && expandedView === "students" ? (
                      <div
                        className="mt-2 border-t border-slate-200 pt-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {loadingItemsBundleId === bundle.id ? (
                          <p className="py-2 text-center text-[11px] text-slate-400">
                            Loading students...
                          </p>
                        ) : (
                          <>
                            <div className="mb-1.5 flex items-center justify-between">
                              <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
                                <Users size={11} />
                                Students
                              </span>
                              <span className="text-[10px] text-slate-400">
                                {recipientsEditable
                                  ? `${accSelCount}/${accStudents.length} selected`
                                  : `${accStudents.filter((st) => st.willReceive).length} recipients`}
                              </span>
                            </div>

                            {accStudents.length === 0 ? (
                              <p className="py-2 text-center text-[11px] text-slate-400">
                                No active students for this month.
                              </p>
                            ) : (
                              <div className="scrollbar-thin max-h-[200px] space-y-0.5 overflow-y-auto">
                                {accStudents.map((st) => (
                                  <label
                                    key={st.id}
                                    className={`flex items-center gap-2 rounded-md px-1.5 py-1 ${
                                      recipientsEditable ? "hover:bg-slate-50" : ""
                                    }`}
                                  >
                                    <input
                                      type="checkbox"
                                      disabled={!recipientsEditable}
                                      checked={
                                        recipientsEditable
                                          ? studentSel[st.id] ?? false
                                          : st.willReceive
                                      }
                                      onChange={(e) =>
                                        setStudentSel((prev) => ({
                                          ...prev,
                                          [st.id]: e.target.checked,
                                        }))
                                      }
                                    />
                                    <span className="text-[12px] text-slate-700">{st.name}</span>
                                    {st.registrationNumber ? (
                                      <span className="text-[10px] text-slate-400">
                                        ({st.registrationNumber})
                                      </span>
                                    ) : null}
                                    {!recipientsEditable && st.willReceive && st.receivedAt ? (
                                      <span className="ml-auto text-[9px] font-semibold text-emerald-600">
                                        confirmed
                                      </span>
                                    ) : null}
                                  </label>
                                ))}
                              </div>
                            )}

                            {recipientsEditable ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void saveRecipients(bundle.id);
                                }}
                                disabled={savingRecipients || accStudents.length === 0}
                                className="mt-1.5 inline-flex w-full items-center justify-center gap-1 rounded-md bg-teal-600 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-teal-700 disabled:opacity-60"
                              >
                                {savingRecipients
                                  ? "Updating..."
                                  : `Update & send to ${accSelCount} student${
                                      accSelCount === 1 ? "" : "s"
                                    }`}
                              </button>
                            ) : (
                              <p className="mt-1.5 text-center text-[10px] text-slate-400">
                                Bundle is sent - the recipient list is locked. Set the status to
                                DRAFT to edit it.
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    ) : null}

                    {expanded && expandedView === "items" ? (
                      <div
                        className="mt-2 border-t border-slate-200 pt-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex gap-1">
                          {(["TUTE", "PAPER"] as const).map((tab) => (
                            <button
                              key={tab}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                accResetForm();
                                setExpandedTab(tab);
                              }}
                              className={`rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] transition ${
                                expandedTab === tab
                                  ? "bg-teal-600 text-white"
                                  : "bg-white text-slate-500 hover:bg-teal-50"
                              }`}
                            >
                              {tab === "TUTE" ? "Tutes" : "Papers"} (
                              {tab === "TUTE" ? accTutes.length : accPapers.length})
                            </button>
                          ))}
                        </div>

                        <div className="mt-2 space-y-1">
                          {loadingItemsBundleId === bundle.id ? (
                            <p className="py-2 text-center text-[11px] text-slate-400">
                              Loading items...
                            </p>
                          ) : (
                            <>
                              {accList.length === 0 && accForm?.mode !== "add" ? (
                                <p className="py-2 text-center text-[11px] text-slate-400">
                                  No {expandedTab === "TUTE" ? "tutes" : "papers"} yet.
                                </p>
                              ) : null}

                              {accList.map((it) => (
                                <div
                                  key={it.id}
                                  className="rounded-md border border-slate-200 bg-white px-2 py-1.5"
                                >
                                  {accForm?.mode === "edit" && accForm.itemId === it.id ? (
                                    <AccordionItemForm
                                      type={it.type}
                                      mode="edit"
                                      title={accTitle}
                                      desc={accDesc}
                                      start={accStart}
                                      end={accEnd}
                                      saving={accSaving}
                                      currentFileName={it.fileName}
                                      onTitle={setAccTitle}
                                      onDesc={setAccDesc}
                                      onFile={setAccFile}
                                      onStart={setAccStart}
                                      onEnd={setAccEnd}
                                      onSubmit={() => void accSubmitForm(bundle.id)}
                                      onCancel={accResetForm}
                                    />
                                  ) : (
                                    <>
                                      <p className="truncate text-[12px] font-semibold text-slate-800">
                                        {it.title}
                                      </p>
                                      {it.description ? (
                                        <p className="mt-0.5 truncate text-[10px] text-slate-500">
                                          {it.description}
                                        </p>
                                      ) : null}
                                      {it.type === "PAPER" && it.paperStartAt ? (
                                        <p className="mt-0.5 text-[10px] text-slate-400">
                                          {new Date(it.paperStartAt).toLocaleString()} -{" "}
                                          {it.paperEndAt
                                            ? new Date(it.paperEndAt).toLocaleString()
                                            : "?"}
                                        </p>
                                      ) : null}
                                      {it.fileName ? (
                                        <p className="mt-0.5 truncate text-[10px] text-slate-400">
                                          {it.fileName}
                                        </p>
                                      ) : null}
                                      <div className="mt-1 flex flex-wrap gap-1">
                                        {it.fileName ? (
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setViewerItem({
                                                bundleId: bundle.id,
                                                itemId: it.id,
                                                title: it.title,
                                                kind: isImageItem(it) ? "image" : "pdf",
                                              });
                                            }}
                                            className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 transition hover:bg-slate-200"
                                          >
                                            <Eye size={11} />
                                            View
                                          </button>
                                        ) : null}
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            accOpenEdit(it);
                                          }}
                                          className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 transition hover:bg-slate-200"
                                        >
                                          <Pencil size={11} />
                                          Edit
                                        </button>
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            void accDeleteItem(bundle.id, it.id);
                                          }}
                                          className="inline-flex items-center gap-0.5 rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600 transition hover:bg-rose-100"
                                        >
                                          <Trash2 size={11} />
                                          Remove
                                        </button>
                                      </div>
                                    </>
                                  )}
                                </div>
                              ))}

                              {accForm?.mode === "add" && accForm.type === expandedTab ? (
                                <div className="rounded-md border border-teal-200 bg-teal-50/40 p-2">
                                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
                                    New {expandedTab === "TUTE" ? "tute" : "paper"}
                                  </p>
                                  <AccordionItemForm
                                    type={accForm.type}
                                    mode="add"
                                    title={accTitle}
                                    desc={accDesc}
                                    start={accStart}
                                    end={accEnd}
                                    saving={accSaving}
                                    onTitle={setAccTitle}
                                    onDesc={setAccDesc}
                                    onFile={setAccFile}
                                    onStart={setAccStart}
                                    onEnd={setAccEnd}
                                    onSubmit={() => void accSubmitForm(bundle.id)}
                                    onCancel={accResetForm}
                                  />
                                </div>
                              ) : accForm === null ? (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    accOpenAdd(expandedTab);
                                  }}
                                  className="mt-1 inline-flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-1.5 text-[11px] font-semibold text-slate-500 transition hover:border-teal-300 hover:text-teal-700"
                                >
                                  <Plus size={12} />
                                  Add {expandedTab === "TUTE" ? "tute" : "paper"}
                                </button>
                              ) : null}
                            </>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {!isLoading && bundles.length === 0 ? (
                <div className="col-span-full rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-center">
                  <span className="mx-auto inline-flex h-11 w-11 items-center justify-center rounded-lg bg-white text-teal-700 shadow-sm">
                    <Files size={18} />
                  </span>
                  <p className="mt-3 text-sm font-semibold text-slate-800">No bundles found</p>
                  <p className="mt-1 text-sm leading-6 text-slate-500">Adjust the filters or create a new monthly bundle to get started.</p>
                </div>
              ) : null}
            </div>

            <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-slate-200 pt-2.5">
              <button
                type="button"
                onClick={() => void loadBundles(Math.max(1, page - 1))}
                disabled={page <= 1 || isLoading}
                className="btn-ghost h-8 gap-1.5 px-3 text-xs disabled:opacity-40"
              >
                <ChevronLeft size={14} />
                Prev
              </button>
              <p className="text-[12px] font-medium text-slate-500">
                {page} / {totalPages}
              </p>
              <button
                type="button"
                onClick={() => void loadBundles(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages || isLoading}
                className="btn-ghost h-8 gap-1.5 px-3 text-xs disabled:opacity-40"
              >
                Next
                <ChevronRight size={14} />
              </button>
            </div>
          </section>
        </div>
      </div>

      {viewerItem ? (
        <div
          className="fixed inset-0 z-[70] flex flex-col bg-black/80 p-4"
          onClick={() => setViewerItem(null)}
        >
          <div
            className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-2">
              <p className="truncate text-sm font-semibold text-slate-800">{viewerItem.title}</p>
              <div className="flex items-center gap-2">
                <a
                  href={`/api/material-bundles/${viewerItem.bundleId}/items/${viewerItem.itemId}/file?download=1`}
                  className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                >
                  Download
                </a>
                <button
                  type="button"
                  onClick={() => setViewerItem(null)}
                  className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-slate-100">
              {viewerItem.kind === "image" ? (
                <div className="flex min-h-full items-center justify-center p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/material-bundles/${viewerItem.bundleId}/items/${viewerItem.itemId}/file`}
                    alt={viewerItem.title}
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
              ) : (
                <iframe
                  src={`/api/material-bundles/${viewerItem.bundleId}/items/${viewerItem.itemId}/file`}
                  title={viewerItem.title}
                  className="h-full w-full border-0"
                />
              )}
            </div>
          </div>
        </div>
      ) : null}

      {isWizardOpen ? (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40"
            onClick={() => setIsWizardOpen(false)}
            aria-hidden
          />
          <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[380px] flex-col border-l border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Add class bundle</p>
                <h4 className="mt-0.5 truncate text-[13px] font-semibold text-slate-900">
                  New class bundle
                </h4>
                {wzClassId ? (
                  <p className="mt-0.5 truncate text-[11px] text-slate-500">
                    {classes.find((c) => c.id === wzClassId)?.name ?? "Class"} &bull; {wzMonthLabel}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setIsWizardOpen(false)}
                className="btn-secondary h-7 w-7 shrink-0 rounded-lg p-0"
                aria-label="Close add class bundle panel"
              >
                <X size={14} />
              </button>
            </div>

            <div className="scrollbar-thin flex-1 overflow-y-auto px-4 py-3">
              <div className="space-y-2.5">
                  <label className="block space-y-1">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Class</span>
                    <div className="relative">
                      <GraduationCap size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                      <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
                      <select
                        value={wzClassId}
                        onChange={(e) => setWzClassId(e.target.value)}
                        className="control-select h-8 appearance-none pl-7 pr-7 text-[12px]"
                      >
                        <option value="">Select class</option>
                        {classes.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </label>

                  <label className="block space-y-1">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Title</span>
                    <input
                      value={wzTitle}
                      onChange={(e) => setWzTitle(e.target.value)}
                      placeholder="e.g. August tutes and papers"
                      maxLength={150}
                      className="control-input h-8 text-[12px]"
                    />
                  </label>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="block space-y-1">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Year</span>
                      <div className="relative">
                        <Calendar size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                        <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
                        <select
                          value={wzYear}
                          onChange={(e) => setWzYear(e.target.value)}
                          className="control-select h-8 appearance-none pl-7 pr-7 text-[12px]"
                        >
                          {yearOptions.map((y) => (
                            <option key={y} value={String(y)}>
                              {y}
                            </option>
                          ))}
                        </select>
                      </div>
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Month</span>
                      <div className="relative">
                        <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
                        <select
                          value={wzMonth}
                          onChange={(e) => setWzMonth(e.target.value)}
                          className="control-select h-8 appearance-none pr-7 text-[12px]"
                        >
                          {Array.from({ length: 12 }).map((_, idx) => (
                            <option key={idx + 1} value={String(idx + 1)}>
                              {monthLabel(idx + 1)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </label>
                  </div>

                  <div className="space-y-2 border-t border-slate-200 pt-2.5">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => wizardOpenItemForm("TUTE")}
                        className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-semibold transition ${
                          wzPopover === "TUTE"
                            ? "border-teal-600 bg-teal-600 text-white"
                            : "border-slate-200 bg-white text-slate-600 hover:bg-teal-50"
                        }`}
                      >
                        <Plus size={13} />
                        Add tute
                      </button>
                      <button
                        type="button"
                        onClick={() => wizardOpenItemForm("PAPER")}
                        className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-semibold transition ${
                          wzPopover === "PAPER"
                            ? "border-teal-600 bg-teal-600 text-white"
                            : "border-slate-200 bg-white text-slate-600 hover:bg-teal-50"
                        }`}
                      >
                        <Plus size={13} />
                        Add paper
                      </button>
                    </div>

                    {wzPopover ? (
                      <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                          {wzEditId ? "Edit" : "New"} {wzPopover === "TUTE" ? "tute" : "paper"}
                        </p>
                        <label className="block space-y-1">
                          <span className="text-[10px] font-medium text-slate-500">
                            Title <span className="text-rose-500">*</span>
                          </span>
                          <input
                            value={wzItemTitle}
                            onChange={(e) => setWzItemTitle(e.target.value)}
                            placeholder="Title"
                            maxLength={150}
                            className="control-input h-8 text-[12px]"
                          />
                        </label>
                        <label className="block space-y-1">
                          <span className="text-[10px] font-medium text-slate-500">Description</span>
                          <textarea
                            value={wzItemDescription}
                            onChange={(e) => setWzItemDescription(e.target.value)}
                            rows={2}
                            placeholder="Optional"
                            className="control-textarea text-[12px]"
                          />
                        </label>
                        <label className="block space-y-1">
                          <span className="text-[10px] font-medium text-slate-500">
                            File {wzItemFile ? `- ${wzItemFile.name}` : "(optional PDF)"}
                          </span>
                          <input
                            type="file"
                            accept="application/pdf"
                            onChange={(e) => setWzItemFile(e.target.files?.[0] ?? null)}
                            className="block w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[11px] file:mr-3 file:rounded-md file:border-0 file:bg-teal-50 file:px-2 file:py-1 file:font-semibold file:text-teal-700"
                          />
                        </label>
                        {wzPopover === "PAPER" ? (
                          <div className="grid grid-cols-2 gap-2">
                            <label className="block space-y-1 text-[10px] font-medium text-slate-500">
                              Start time <span className="text-rose-500">*</span>
                              <input
                                type="datetime-local"
                                value={wzPaperStart}
                                onChange={(e) => setWzPaperStart(e.target.value)}
                                className="control-input h-8 text-[12px]"
                              />
                            </label>
                            <label className="block space-y-1 text-[10px] font-medium text-slate-500">
                              End time <span className="text-rose-500">*</span>
                              <input
                                type="datetime-local"
                                value={wzPaperEnd}
                                onChange={(e) => setWzPaperEnd(e.target.value)}
                                className="control-input h-8 text-[12px]"
                              />
                            </label>
                          </div>
                        ) : null}
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={wizardResetItemForm}
                            className="btn-ghost h-7 px-3 text-[11px]"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={wizardSavePendingItem}
                            className="btn-primary h-7 px-3 text-[11px]"
                          >
                            {wzEditId ? "Save" : "Add"}
                          </button>
                        </div>
                      </div>
                    ) : null}

                    <div className="space-y-1.5">
                      {wzPending.length === 0 ? (
                        <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-center text-[11px] text-slate-500">
                          No tutes or papers added yet.
                        </p>
                      ) : (
                        wzPending.map((item) => (
                          <div
                            key={item.localId}
                            className="flex items-start justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                                  {item.type}
                                </span>
                                <p className="truncate text-[12px] font-semibold text-slate-900">
                                  {item.title}
                                </p>
                              </div>
                              {item.type === "PAPER" && item.paperStartAt ? (
                                <p className="mt-0.5 text-[10px] text-slate-400">
                                  {new Date(item.paperStartAt).toLocaleString()} -{" "}
                                  {item.paperEndAt ? new Date(item.paperEndAt).toLocaleString() : "?"}
                                </p>
                              ) : null}
                              {item.file ? (
                                <p className="mt-0.5 truncate text-[10px] text-slate-400">{item.file.name}</p>
                              ) : null}
                            </div>
                            <div className="flex shrink-0 items-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => wizardEditPendingItem(item)}
                                className="rounded-md p-1 text-slate-400 transition hover:bg-teal-50 hover:text-teal-700"
                                aria-label="Edit item"
                              >
                                <Pencil size={12} />
                              </button>
                              <button
                                type="button"
                                onClick={() => wizardRemovePendingItem(item.localId)}
                                className="rounded-md p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                                aria-label="Remove item"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between px-0.5">
                      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                        <Users size={12} />
                        Active students
                      </span>
                      <span className="text-[10px] font-medium text-slate-400">
                        {wzSelectedCount}/{wzStudents.length} selected
                      </span>
                    </div>
                    <div className="scrollbar-thin max-h-[220px] overflow-y-auto rounded-lg border border-slate-200 bg-white p-1">
                      {wzLoadingStudents ? (
                        <p className="px-2 py-2.5 text-center text-[11px] text-slate-400">Loading students...</p>
                      ) : wzStudents.length === 0 ? (
                        <p className="px-2 py-2.5 text-center text-[11px] text-slate-400">
                          {wzClassId ? "No active students for this month." : "Select a class to load students."}
                        </p>
                      ) : (
                        wzStudents.map((s) => (
                          <label
                            key={s.id}
                            className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-slate-50"
                          >
                            <input
                              type="checkbox"
                              checked={wzStudentSel[s.id] ?? false}
                              onChange={(e) =>
                                setWzStudentSel((prev) => ({ ...prev, [s.id]: e.target.checked }))
                              }
                            />
                            <span className="text-[12px] text-slate-700">{s.name}</span>
                            {s.registrationNumber ? (
                              <span className="text-[10px] text-slate-400">({s.registrationNumber})</span>
                            ) : null}
                          </label>
                        ))
                      )}
                    </div>
                  </div>

                  <p className="rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-[10px] leading-4 text-sky-800">
                    All active students are selected. Deselect anyone who should not receive
                    this bundle, then submit to add the rest as recipients.
                  </p>
                </div>
            </div>

            <div className="border-t border-slate-200 px-4 py-2.5">
              <button
                type="button"
                onClick={() => void wizardSubmit()}
                disabled={wzSaving}
                className="btn-primary h-8 w-full text-[11px] disabled:opacity-60"
              >
                {wzSaving
                  ? "Submitting..."
                  : `Create bundle & send to ${wzSelectedCount} student${wzSelectedCount === 1 ? "" : "s"}`}
              </button>
            </div>
          </aside>
        </>
      ) : null}

    </div>
  );
}
