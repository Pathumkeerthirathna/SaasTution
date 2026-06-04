"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  Eye,
  FileText,
  Files,
  GraduationCap,
  List,
  Pencil,
  Plus,
  MoreHorizontal,
  Search,
  Send,
  Trash2,
  Users,
  X,
} from "lucide-react";

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
  status: "DRAFT" | "SENT";
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

type BundleStudent = {
  id: string;
  name: string;
  registrationNumber: string | null;
  willReceive: boolean;
  receivedAt: string | null;
};

type BundleDetail = {
  id: string;
  classId: string;
  className: string;
  title: string;
  year: number;
  month: number;
  status: "DRAFT" | "SENT";
  sentAt: string | null;
  createdAt: string;
  items: BundleItem[];
  students: BundleStudent[];
  hasRecipientSelections: boolean;
  summary: {
    totalStudents: number;
    willReceiveCount: number;
    willNotReceiveCount: number;
  };
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

type PaperSubmissionRecord = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  submittedAt: string;
  isLate: boolean;
};

type PaperSubmissionStudent = {
  id: string;
  name: string;
  registrationNumber: string | null;
  hasSubmitted: boolean;
  latestSubmittedAt: string | null;
  supportMessages: {
    id: string;
    message: string;
    createdAt: string;
  }[];
  submissions: PaperSubmissionRecord[];
};

type PaperSubmissionView = {
  item: {
    id: string;
    title: string;
    paperEndAt: string | null;
  };
  classroom: {
    id: string;
    name: string;
  };
  students: PaperSubmissionStudent[];
  summary: {
    totalStudents: number;
    submittedStudents: number;
    notSubmittedStudents: number;
  };
};

function readApiError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const typed = payload as ApiError;
  return typed.error?.message ?? typed.message ?? fallback;
}

function monthLabel(month: number) {
  return new Date(2000, month - 1, 1).toLocaleString("en-US", { month: "long" });
}

function formatBytes(bytes: number | null) {
  if (!bytes) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toDateTimeLocal(value: string | null) {
  if (!value) return "";
  const d = new Date(value);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

export function MaterialBundlePanel() {
  const now = new Date();

  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [bundles, setBundles] = useState<BundleListItem[]>([]);

  const [filterClassId, setFilterClassId] = useState("");
  const [filterYear, setFilterYear] = useState(String(now.getFullYear()));
  const [filterMonth, setFilterMonth] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);
  const [bundleDetail, setBundleDetail] = useState<BundleDetail | null>(null);

  const [createClassId, setCreateClassId] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [createYear, setCreateYear] = useState(String(now.getFullYear()));
  const [createMonth, setCreateMonth] = useState(String(now.getMonth() + 1));

  const [itemType, setItemType] = useState<"TUTE" | "PAPER">("TUTE");
  const [itemTitle, setItemTitle] = useState("");
  const [itemDescription, setItemDescription] = useState("");
  const [itemFile, setItemFile] = useState<File | null>(null);
  const [paperStartAt, setPaperStartAt] = useState("");
  const [paperEndAt, setPaperEndAt] = useState("");

  const [editItemId, setEditItemId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPaperStartAt, setEditPaperStartAt] = useState("");
  const [editPaperEndAt, setEditPaperEndAt] = useState("");

  const [recipientSelection, setRecipientSelection] = useState<Record<string, boolean>>({});
  const [isRecipientPanelOpen, setIsRecipientPanelOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isCreatePanelOpen, setIsCreatePanelOpen] = useState(false);
  const [isItemPanelOpen, setIsItemPanelOpen] = useState(false);
  const [confirmAddToSentBundle, setConfirmAddToSentBundle] = useState(false);
  const [activeItemTab, setActiveItemTab] = useState<"TUTE" | "PAPER">("TUTE");
  const [isSubmissionsOpen, setIsSubmissionsOpen] = useState(false);
  const [isLoadingSubmissions, setIsLoadingSubmissions] = useState(false);
  const [submissionsView, setSubmissionsView] = useState<PaperSubmissionView | null>(null);
  const [submissionsItemId, setSubmissionsItemId] = useState<string | null>(null);
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);

  const [previewItem, setPreviewItem] = useState<BundleItem | null>(null);
  const [isPreviewFullScreen, setIsPreviewFullScreen] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

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

      const classList = payload.data ?? [];
      setClasses(classList);
      if (!createClassId && classList[0]) {
        setCreateClassId(classList[0].id);
      }
    }

    void loadClasses().catch((error) => {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load classes.");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isActionMenuOpen) return;

    function handleOutsideClick(event: MouseEvent) {
      if (actionMenuRef.current && !actionMenuRef.current.contains(event.target as Node)) {
        setIsActionMenuOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsActionMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isActionMenuOpen]);

  async function loadBundles(nextPage = page) {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const qs = new URLSearchParams({
        page: String(nextPage),
        pageSize: "8",
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
        const nextId = list[0]?.id ?? null;
        setSelectedBundleId(nextId);
        if (nextId) {
          await loadBundleDetails(nextId);
        } else {
          setBundleDetail(null);
        }
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load bundles.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadBundles(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterClassId, filterYear, filterMonth]);

  async function loadBundleDetails(bundleId: string) {
    setIsLoadingDetails(true);

    try {
      const response = await fetch(`/api/material-bundles/${bundleId}`, { cache: "no-store" });
      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          bundle: BundleDetail;
        };
      };

      if (!response.ok || !payload.success || !payload.data?.bundle) {
        throw new Error(readApiError(payload, "Failed to load bundle details."));
      }

      setBundleDetail(payload.data.bundle);
      setSelectedBundleId(bundleId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load bundle details.");
    } finally {
      setIsLoadingDetails(false);
    }
  }

  async function handleCreateBundle() {
    if (!createClassId) {
      setErrorMessage("Class is required.");
      return;
    }
    if (!createTitle.trim()) {
      setErrorMessage("Bundle title is required.");
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch("/api/material-bundles", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          classId: createClassId,
          title: createTitle.trim(),
          year: Number(createYear),
          month: Number(createMonth),
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: { bundle: { id: string } };
      };

      if (!response.ok || !payload.success || !payload.data?.bundle?.id) {
        throw new Error(readApiError(payload, "Failed to create bundle."));
      }

      await loadBundles(1);
      await loadBundleDetails(payload.data.bundle.id);
      setSuccessMessage("Bundle created successfully.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to create bundle.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleAddItem() {
    if (!selectedBundleId) {
      setErrorMessage("Select a bundle first.");
      return;
    }

    if (bundleDetail?.status === "SENT" && !confirmAddToSentBundle) {
      setErrorMessage("This bundle is already sent. Confirm before adding a new item.");
      return;
    }

    if (!itemTitle.trim()) {
      setErrorMessage("Item title is required.");
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const formData = new FormData();
      formData.set("type", itemType);
      formData.set("title", itemTitle.trim());
      if (itemDescription.trim()) formData.set("description", itemDescription.trim());
      if (itemType === "PAPER") {
        formData.set("paperStartAt", paperStartAt);
        formData.set("paperEndAt", paperEndAt);
      }
      if (itemFile) formData.set("file", itemFile);

      const response = await fetch(`/api/material-bundles/${selectedBundleId}/items`, {
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

      const newItem = payload.data.item;

      setItemTitle("");
      setItemDescription("");
      setItemFile(null);
      setPaperStartAt("");
      setPaperEndAt("");
      setConfirmAddToSentBundle(false);
      setIsItemPanelOpen(false);

      setBundleDetail((prev) =>
        prev ? { ...prev, items: [...prev.items, newItem] } : prev
      );
      setBundles((prev) =>
        prev.map((b) =>
          b.id === selectedBundleId
            ? { ...b, _count: { ...b._count, items: b._count.items + 1 } }
            : b
        )
      );
      setSuccessMessage("Item added successfully.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to add item.");
    } finally {
      setIsSaving(false);
    }
  }

  function openAddItemPanel() {
    if (!selectedBundleId || !bundleDetail) {
      setErrorMessage("Select a bundle first.");
      return;
    }

    setConfirmAddToSentBundle(false);
    setIsItemPanelOpen(true);
  }

  async function handleDeleteItem(itemId: string) {
    if (!selectedBundleId) return;

    const confirmed = window.confirm("Delete this item?");
    if (!confirmed) return;

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/material-bundles/${selectedBundleId}/items/${itemId}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to delete item."));
      }

      setBundleDetail((prev) =>
        prev ? { ...prev, items: prev.items.filter((i) => i.id !== itemId) } : prev
      );
      setBundles((prev) =>
        prev.map((b) =>
          b.id === selectedBundleId
            ? { ...b, _count: { ...b._count, items: Math.max(0, b._count.items - 1) } }
            : b
        )
      );
      setSuccessMessage("Item deleted successfully.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to delete item.");
    } finally {
      setIsSaving(false);
    }
  }

  async function openSubmissions(item: BundleItem) {
    if (!selectedBundleId) return;

    setIsSubmissionsOpen(true);
    setIsLoadingSubmissions(true);
    setSubmissionsItemId(item.id);
    setSubmissionsView(null);
    setErrorMessage(null);

    try {
      const response = await fetch(
        `/api/material-bundles/${selectedBundleId}/items/${item.id}/submissions`,
        { cache: "no-store" }
      );
      const payload = (await response.json()) as {
        success: boolean;
        data?: PaperSubmissionView;
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(readApiError(payload, "Failed to load submissions."));
      }

      setSubmissionsView(payload.data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load submissions.");
    } finally {
      setIsLoadingSubmissions(false);
    }
  }

  function beginEditItem(item: BundleItem) {
    setActiveItemTab(item.type);
    setEditItemId(item.id);
    setEditTitle(item.title);
    setEditDescription(item.description ?? "");
    setEditPaperStartAt(toDateTimeLocal(item.paperStartAt));
    setEditPaperEndAt(toDateTimeLocal(item.paperEndAt));
  }

  async function handleSaveItemEdit(itemType: "TUTE" | "PAPER") {
    if (!selectedBundleId || !editItemId) return;

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const payload: {
        title: string;
        description?: string;
        paperStartAt?: string | null;
        paperEndAt?: string | null;
      } = {
        title: editTitle.trim(),
      };

      if (editDescription.trim()) payload.description = editDescription.trim();
      if (itemType === "PAPER") {
        payload.paperStartAt = editPaperStartAt ? new Date(editPaperStartAt).toISOString() : null;
        payload.paperEndAt = editPaperEndAt ? new Date(editPaperEndAt).toISOString() : null;
      }

      const response = await fetch(`/api/material-bundles/${selectedBundleId}/items/${editItemId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const resultPayload = (await response.json()) as {
        success: boolean;
        data?: { item: BundleItem };
      };
      if (!response.ok || !resultPayload.success || !resultPayload.data?.item) {
        throw new Error(readApiError(resultPayload, "Failed to update item."));
      }

      const updatedItem = resultPayload.data.item;
      setEditItemId(null);
      setBundleDetail((prev) =>
        prev
          ? { ...prev, items: prev.items.map((i) => (i.id === updatedItem.id ? updatedItem : i)) }
          : prev
      );
      setSuccessMessage("Item updated successfully.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update item.");
    } finally {
      setIsSaving(false);
    }
  }

  function openRecipientPanel() {
    if (!bundleDetail) return;

    const selection: Record<string, boolean> = {};
    for (const student of bundleDetail.students) {
      selection[student.id] = bundleDetail.hasRecipientSelections ? student.willReceive : true;
    }
    setRecipientSelection(selection);
    setIsRecipientPanelOpen(true);
  }

  async function saveRecipientsAndSend() {
    if (!selectedBundleId) return;

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const selectedStudentIds = Object.entries(recipientSelection)
        .filter(([, selected]) => selected)
        .map(([id]) => id);

      const response = await fetch(`/api/material-bundles/${selectedBundleId}/recipients`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ selectedStudentIds }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: { bundle: BundleDetail };
      };

      if (!response.ok || !payload.success || !payload.data?.bundle) {
        throw new Error(readApiError(payload, "Failed to save recipients."));
      }

      setIsRecipientPanelOpen(false);
      setBundleDetail(payload.data.bundle);
      setBundles((prev) =>
        prev.map((bundle) =>
          bundle.id === selectedBundleId
            ? {
                ...bundle,
                status: payload.data?.bundle.status ?? bundle.status,
                sentAt: payload.data?.bundle.sentAt ?? bundle.sentAt,
                _count: {
                  ...bundle._count,
                  recipients: payload.data?.bundle.summary.willReceiveCount ?? bundle._count.recipients,
                },
              }
            : bundle
        )
      );
      setSuccessMessage("Bundle sent with selected recipients.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to save recipients.");
    } finally {
      setIsSaving(false);
    }
  }

  const tuteItems = useMemo(
    () => (bundleDetail?.items ?? []).filter((item) => item.type === "TUTE"),
    [bundleDetail?.items]
  );
  const paperItems = useMemo(
    () => (bundleDetail?.items ?? []).filter((item) => item.type === "PAPER"),
    [bundleDetail?.items]
  );

  return (
    <div className="px-0 py-1 sm:py-0">


      {errorMessage ? (
        <p className="notice-error mt-4">{errorMessage}</p>
      ) : null}
      {successMessage ? (
        <p className="notice-success mt-4">
          {successMessage}
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)] 2xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="self-start">
          <section className="surface-card border border-brand-100/80 p-6 shadow-card">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-muted">Bundle List</p>
                <p className="mt-1 text-sm text-slate-500">Select a monthly bundle to review recipients and content.</p>
              </div>
              <div className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-brand-100 px-2 text-xs font-semibold text-brand-700">
                {bundles.length}
              </div>
            </div>

            <details className="mt-4 rounded-2xl border border-brand-100 bg-brand-50/40 p-3">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">
                Filters
              </summary>
              <div className="mt-3 space-y-3">
                <div className="relative">
                  <GraduationCap size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
                  <ChevronDown size={18} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-muted" />
                  <select
                    value={filterClassId}
                    onChange={(e) => setFilterClassId(e.target.value)}
                    className="control-select h-12 appearance-none pl-12 pr-12 text-[14px]"
                  >
                    <option value="">All classes</option>
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    value={filterYear}
                    onChange={(e) => setFilterYear(e.target.value)}
                    placeholder="Year"
                    className="control-input h-12 text-[14px]"
                  />
                  <div className="relative">
                    <Calendar size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
                    <ChevronDown size={16} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-muted" />
                    <select
                      value={filterMonth}
                      onChange={(e) => setFilterMonth(e.target.value)}
                      className="control-select h-12 appearance-none pl-11 pr-11 text-[14px]"
                    >
                      <option value="">Month</option>
                      {Array.from({ length: 12 }).map((_, idx) => (
                        <option key={idx + 1} value={String(idx + 1)}>
                          {monthLabel(idx + 1)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </details>

            {isLoading ? <p className="mt-4 text-xs font-medium text-slate-400">Loading...</p> : null}
            <div className="mt-4 space-y-3">
              {bundles.map((bundle) => (
                <button
                  key={bundle.id}
                  type="button"
                  onClick={() => void loadBundleDetails(bundle.id)}
                  className={`group w-full rounded-[20px] border px-4 py-4 text-left shadow-soft transition-all duration-200 ${
                    selectedBundleId === bundle.id
                      ? "border-brand-300 bg-brand-50/80 shadow-card"
                      : "border-brand-100 bg-white hover:-translate-y-0.5 hover:border-brand-200 hover:bg-brand-50/70 hover:shadow-card"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${
                      selectedBundleId === bundle.id ? "bg-white text-brand-700" : "bg-brand-50 text-brand-600"
                    }`}>
                      <FileText size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="text-[16px] font-semibold leading-6 text-slate-900">{bundle.title}</p>
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${
                          bundle.status === "SENT"
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-slate-100 text-slate-600"
                        }`}>
                          {bundle.status}
                        </span>
                      </div>
                      <p className="mt-1 text-[13px] font-medium text-slate-500">
                        {bundle.class.name} • {monthLabel(bundle.month)} {bundle.year}
                      </p>
                      <div className="mt-3 space-y-1.5 text-[13px] leading-5 text-slate-400">
                        <p>{bundle._count.items} items in this bundle</p>
                        <p>Created {new Date(bundle.createdAt).toLocaleDateString()}</p>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
              {!isLoading && bundles.length === 0 ? (
                <div className="rounded-[20px] border border-dashed border-brand-200 bg-brand-50/50 p-5 text-center">
                  <span className="mx-auto inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-brand-700 shadow-soft">
                    <Files size={18} />
                  </span>
                  <p className="mt-3 text-sm font-semibold text-slate-800">No bundles found</p>
                  <p className="mt-1 text-sm leading-6 text-slate-500">Adjust the filters or create a new monthly bundle to get started.</p>
                </div>
              ) : null}
            </div>

            <div className="mt-5 flex items-center justify-between gap-3 border-t border-brand-100 pt-4">
              <button
                type="button"
                onClick={() => void loadBundles(Math.max(1, page - 1))}
                disabled={page <= 1 || isLoading}
                className="btn-ghost h-10 gap-1.5 px-3 text-xs disabled:opacity-40"
              >
                <ChevronLeft size={14} />
                Prev
              </button>
              <p className="text-[13px] font-medium text-slate-500">
                {page} / {totalPages}
              </p>
              <button
                type="button"
                onClick={() => void loadBundles(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages || isLoading}
                className="btn-ghost h-10 gap-1.5 px-3 text-xs disabled:opacity-40"
              >
                Next
                <ChevronRight size={14} />
              </button>
            </div>
          </section>
        </aside>

        <div className="grid gap-6">
          {!bundleDetail || isLoadingDetails ? (
            <div className="surface-card flex min-h-[420px] flex-col items-center justify-center rounded-[24px] border border-brand-100/80 px-6 py-10 text-center shadow-card">
              <span className="inline-flex h-14 w-14 items-center justify-center rounded-[20px] bg-white text-brand-700 shadow-soft">
                <FileText size={22} />
              </span>
              <p className="mt-4 text-lg font-semibold text-slate-900">
                {isLoadingDetails ? "Loading bundle details..." : "Select a bundle to manage items and recipients."}
              </p>
              <p className="mt-2 max-w-md text-[15px] leading-7 text-slate-500">
                Choose a bundle from the left panel to review students, upload monthly learning materials, and track paper submissions.
              </p>
            </div>
          ) : (
            <>
              <section className="surface-card border border-brand-100/80 p-6 shadow-card sm:p-7">
                <div className="flex items-start justify-between gap-6">

                  <div className="flex min-w-0 flex-1 items-start gap-4">
                    <span className="inline-flex h-14 w-14 items-center justify-center rounded-[20px] bg-brand-50 text-brand-700 shadow-soft">
                      <FileText size={22} />
                    </span>

                    <div>
                      

                      <h3 className=" text-[30px] font-semibold tracking-[-0.03em] text-slate-900 sm:text-[34px]">
                        {bundleDetail.title}
                      </h3>

                      <p className="mt-2 text-[15px] font-medium text-slate-500">
                        {bundleDetail.className} • {monthLabel(bundleDetail.month)} {bundleDetail.year}
                      </p>
                    </div>
                  </div>

                  <div className="relative shrink-0" ref={actionMenuRef}>
                    <button
                      type="button"
                      onClick={() => setIsActionMenuOpen((prev) => !prev)}
                      aria-label="Open actions menu"
                      aria-expanded={isActionMenuOpen}
                      className="btn-secondary h-10 w-10 rounded-xl p-0"
                    >
                      <MoreHorizontal size={18} />
                    </button>

                    {isActionMenuOpen ? (
                      <div className="absolute right-0 z-20 mt-2 w-56 rounded-2xl border border-brand-100 bg-white p-2 shadow-card">
                        <button
                          type="button"
                          onClick={() => {
                            setIsActionMenuOpen(false);
                            openRecipientPanel();
                          }}
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-brand-50"
                        >
                          <Send size={16} />
                          Set recipients & send
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setIsActionMenuOpen(false);
                            setIsHelpOpen(true);
                          }}
                          className="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-brand-50"
                        >
                          <CircleHelp size={16} />
                          Help
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setIsActionMenuOpen(false);
                            setIsCreatePanelOpen(true);
                          }}
                          className="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-brand-50"
                        >
                          <Plus size={16} />
                          Add bundle
                        </button>
                      </div>
                    ) : null}
                  </div>

                </div>

                <div className="mt-7 grid gap-4 xl:grid-cols-3">
                  <div className="rounded-[20px] border border-brand-100 bg-white p-5 shadow-soft">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-muted">Class students</p>
                        <p className="mt-3 text-[30px] font-bold leading-none text-slate-900">{bundleDetail.summary.totalStudents}</p>
                      </div>
                      <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand-700">
                        <Users size={20} />
                      </span>
                    </div>
                  </div>
                  <div className="rounded-[20px] border border-emerald-200 bg-emerald-50/80 p-5 shadow-soft">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-emerald-700">Will receive</p>
                        <p className="mt-3 text-[30px] font-bold leading-none text-emerald-700">{bundleDetail.summary.willReceiveCount}</p>
                      </div>
                      <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-white/80 text-emerald-700">
                        <CheckCircle2 size={20} />
                      </span>
                    </div>
                  </div>
                  <div className="rounded-[20px] border border-amber-200 bg-amber-50/80 p-5 shadow-soft">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-amber-700">Will not receive</p>
                        <p className="mt-3 text-[30px] font-bold leading-none text-amber-700">{bundleDetail.summary.willNotReceiveCount}</p>
                      </div>
                      <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-white/80 text-amber-700">
                        <AlertCircle size={20} />
                      </span>
                    </div>
                  </div>
                </div>

                <div className="mt-7 rounded-[24px] border border-brand-100 bg-gradient-to-r from-white via-brand-50/50 to-white p-5 shadow-soft">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-brand-700 shadow-soft">
                        <Files size={18} />
                      </span>
                      <div>
                        <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-muted">Add tute / paper</p>
                        <p className="mt-2 text-[15px] leading-6 text-slate-500">Open the side panel to add new items to this bundle.</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={openAddItemPanel}
                      className="btn-secondary h-11 gap-2.5 px-4 text-sm"
                    >
                      <Plus size={18} />
                      Add tute / paper
                    </button>
                  </div>
                </div>
                <div className="mt-7 overflow-hidden rounded-[24px] border border-brand-100 bg-white shadow-soft">
                  <div className="flex items-center gap-2 border-b border-brand-100 px-5 py-5">
                  <button
                    type="button"
                    onClick={() => setActiveItemTab("TUTE")}
                    className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition ${
                      activeItemTab === "TUTE"
                        ? "bg-brand-700 text-white shadow-soft"
                        : "border border-brand-100 bg-white text-slate-500 hover:bg-brand-50 hover:text-slate-900"
                    }`}
                  >
                    <FileText size={16} />
                    Tutes ({tuteItems.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveItemTab("PAPER")}
                    className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition ${
                      activeItemTab === "PAPER"
                        ? "bg-brand-700 text-white shadow-soft"
                        : "border border-brand-100 bg-white text-slate-500 hover:bg-brand-50 hover:text-slate-900"
                    }`}
                  >
                    <Files size={16} />
                    Papers ({paperItems.length})
                  </button>
                  </div>

                  <div className="p-5 sm:p-6">
                  {activeItemTab === "TUTE" ? (
                    <div className="space-y-3">
                      {tuteItems.map((item) => (
                        <div key={item.id} className="rounded-[20px] border border-brand-100 bg-slate-50/70 p-4 shadow-soft">
                          {editItemId === item.id ? (
                            <>
                              <input
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                                className="w-full rounded-xl border border-brand-200 px-3 py-2.5 text-sm"
                              />
                              <textarea
                                value={editDescription}
                                onChange={(e) => setEditDescription(e.target.value)}
                                rows={2}
                                className="mt-2 w-full rounded-xl border border-brand-200 px-3 py-2.5 text-sm"
                              />
                              <div className="mt-2 flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => void handleSaveItemEdit(item.type)}
                                  className="btn-secondary px-3 py-1.5 text-xs"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditItemId(null)}
                                  className="btn-ghost px-3 py-1.5 text-xs"
                                >
                                  Cancel
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex items-start gap-3">
                                  <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-brand-700 shadow-soft">
                                    <FileText size={18} />
                                  </span>
                                  <div>
                                    <p className="text-[16px] font-semibold text-slate-900">{item.title}</p>
                                    {item.description ? <p className="mt-1 text-sm leading-6 text-slate-500">{item.description}</p> : null}
                                  </div>
                                </div>
                              </div>
                              <div className="mt-4 space-y-1.5 text-[13px] leading-6 text-slate-400">
                                <p>Created {new Date(item.createdAt).toLocaleString()}</p>
                                <p>File: {item.fileName ?? "No file"} ({formatBytes(item.sizeBytes)})</p>
                              </div>
                              <div className="mt-4 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() => beginEditItem(item)}
                                  className="btn-secondary gap-1.5 px-3 py-1.5 text-xs"
                                >
                                  <Pencil size={12} />
                                  Edit
                                </button>
                                {item.fileUrl ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => setPreviewItem(item)}
                                      className="btn-secondary gap-1.5 px-3 py-1.5 text-xs"
                                    >
                                      <Eye size={12} />
                                      Preview
                                    </button>
                                    <a
                                      href={`/api/material-bundles/${bundleDetail.id}/items/${item.id}/file?download=1`}
                                      className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
                                    >
                                      <Download size={12} />
                                      Download
                                    </a>
                                  </>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteItem(item.id)}
                                  className="btn-danger gap-1.5 px-3 py-1.5 text-xs"
                                >
                                  <Trash2 size={12} />
                                  Delete
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                      {tuteItems.length === 0 ? (
                        <div className="rounded-[20px] border border-dashed border-brand-200 bg-brand-50/40 p-6 text-center">
                          <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-brand-700 shadow-soft">
                            <FileText size={18} />
                          </span>
                          <p className="mt-3 text-sm font-semibold text-slate-900">No tutes added yet</p>
                          <p className="mt-1 text-sm leading-6 text-slate-500">Use the add item panel to attach monthly tutes to this bundle.</p>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {paperItems.map((item) => (
                        <div key={item.id} className="rounded-[20px] border border-brand-100 bg-slate-50/70 p-4 shadow-soft">
                          {editItemId === item.id ? (
                            <>
                              <input
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                                className="w-full rounded-xl border border-brand-200 px-3 py-2.5 text-sm"
                              />
                              <textarea
                                value={editDescription}
                                onChange={(e) => setEditDescription(e.target.value)}
                                rows={2}
                                className="mt-2 w-full rounded-xl border border-brand-200 px-3 py-2.5 text-sm"
                              />
                              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                <input
                                  type="datetime-local"
                                  value={editPaperStartAt}
                                  onChange={(e) => setEditPaperStartAt(e.target.value)}
                                  className="rounded-xl border border-brand-200 px-3 py-2.5 text-sm"
                                />
                                <input
                                  type="datetime-local"
                                  value={editPaperEndAt}
                                  onChange={(e) => setEditPaperEndAt(e.target.value)}
                                  className="rounded-xl border border-brand-200 px-3 py-2.5 text-sm"
                                />
                              </div>
                              <div className="mt-2 flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => void handleSaveItemEdit(item.type)}
                                  className="btn-secondary px-3 py-1.5 text-xs"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditItemId(null)}
                                  className="btn-ghost px-3 py-1.5 text-xs"
                                >
                                  Cancel
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex items-start gap-3">
                                  <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-brand-700 shadow-soft">
                                    <Files size={18} />
                                  </span>
                                  <div>
                                    <p className="text-[16px] font-semibold text-slate-900">{item.title}</p>
                                    {item.description ? <p className="mt-1 text-sm leading-6 text-slate-500">{item.description}</p> : null}
                                  </div>
                                </div>
                              </div>
                              <div className="mt-4 space-y-1.5 text-[13px] leading-6 text-slate-400">
                                <p>Created {new Date(item.createdAt).toLocaleString()}</p>
                                <p>
                                  Window: {item.paperStartAt ? new Date(item.paperStartAt).toLocaleString() : "-"} -{" "}
                                  {item.paperEndAt ? new Date(item.paperEndAt).toLocaleString() : "-"}
                                </p>
                                <p>File: {item.fileName ?? "No file"} ({formatBytes(item.sizeBytes)})</p>
                              </div>
                              <div className="mt-4 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() => beginEditItem(item)}
                                  className="btn-secondary gap-1.5 px-3 py-1.5 text-xs"
                                >
                                  <Pencil size={12} />
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void openSubmissions(item)}
                                  className="btn-secondary gap-1.5 px-3 py-1.5 text-xs"
                                >
                                  <List size={12} />
                                  Submissions
                                </button>
                                {item.fileUrl ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => setPreviewItem(item)}
                                      className="btn-secondary gap-1.5 px-3 py-1.5 text-xs"
                                    >
                                      <Eye size={12} />
                                      Preview
                                    </button>
                                    <a
                                      href={`/api/material-bundles/${bundleDetail.id}/items/${item.id}/file?download=1`}
                                      className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
                                    >
                                      <Download size={12} />
                                      Download
                                    </a>
                                  </>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteItem(item.id)}
                                  className="btn-danger gap-1.5 px-3 py-1.5 text-xs"
                                >
                                  <Trash2 size={12} />
                                  Delete
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                      {paperItems.length === 0 ? (
                        <div className="rounded-[20px] border border-dashed border-brand-200 bg-brand-50/40 p-6 text-center">
                          <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-brand-700 shadow-soft">
                            <Files size={18} />
                          </span>
                          <p className="mt-3 text-sm font-semibold text-slate-900">No papers added yet</p>
                          <p className="mt-1 text-sm leading-6 text-slate-500">Add a paper with a time window when you are ready to collect submissions.</p>
                        </div>
                      ) : null}
                    </div>
                  )}
                  </div>
                </div>

                <div className="mt-7 grid gap-4 lg:grid-cols-2">
                  <div className="flex h-full flex-col rounded-[24px] border border-emerald-200 bg-emerald-50/80 p-5 shadow-soft lg:h-[220px]">
                    <p className="text-base font-semibold text-emerald-700">
                      {bundleDetail.status === "SENT" ? "Students this bundle was sent to" : "Students who will receive"}
                    </p>
                    <div className="mt-4 flex flex-1 flex-col overflow-y-auto pr-1">
                      <div className="space-y-2">
                        {bundleDetail.students
                          .filter((s) => s.willReceive)
                          .map((student) => (
                            <div key={student.id} className="flex items-center justify-between gap-3 rounded-2xl border border-emerald-200/70 bg-white/80 px-3 py-2.5 text-sm text-emerald-700">
                              <span className="font-medium text-slate-700">
                                {student.name}
                                {student.registrationNumber ? ` (${student.registrationNumber})` : ""}
                              </span>
                              <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${student.receivedAt ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                                {student.receivedAt ? `Confirmed ${new Date(student.receivedAt).toLocaleString()}` : "Waiting for confirmation"}
                              </span>
                            </div>
                          ))}
                        {bundleDetail.students.filter((s) => s.willReceive).length === 0 ? (
                          <p className="text-sm leading-6 text-emerald-700/80">No students selected.</p>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="flex h-full flex-col rounded-[24px] border border-amber-200 bg-amber-50/80 p-5 shadow-soft lg:h-[220px]">
                    <p className="text-base font-semibold text-amber-700">Students who will not receive</p>
                    <div className="mt-4 flex flex-1 flex-col overflow-y-auto pr-1">
                      <div className="space-y-2">
                        {bundleDetail.students
                          .filter((s) => !s.willReceive)
                          .map((student) => (
                            <div key={student.id} className="rounded-2xl border border-amber-200/80 bg-white/80 px-3 py-2.5 text-sm font-medium text-slate-700">
                              {student.name}
                              {student.registrationNumber ? ` (${student.registrationNumber})` : ""}
                            </div>
                          ))}
                        {bundleDetail.students.filter((s) => !s.willReceive).length === 0 ? (
                          <p className="text-sm leading-6 text-amber-700/80">All students are selected.</p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
      </div>

      {isRecipientPanelOpen && bundleDetail ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-black/10 bg-card p-4 shadow-2xl dark:border-white/10">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">Send Bundle</p>
                <h4 className="text-base font-semibold">
                  {bundleDetail.title}
                </h4>
                <p className="text-xs text-muted">
                  {bundleDetail.className} • {monthLabel(bundleDetail.month)} {bundleDetail.year}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsRecipientPanelOpen(false)}
                className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/15"
              >
                Close
              </button>
            </div>

            <p className="mt-2 text-xs text-muted">
              Select students who should receive this month bundle. All students are pre-selected initially.
            </p>

            <div className="scrollbar-none mt-3 max-h-[320px] overflow-y-auto rounded-xl border border-black/10 p-3 dark:border-white/10">
              {bundleDetail.students.map((student) => (
                <label key={student.id} className="flex items-center gap-2 border-b border-black/5 py-1.5 last:border-b-0 dark:border-white/5">
                  <input
                    type="checkbox"
                    checked={recipientSelection[student.id] ?? false}
                    onChange={(e) =>
                      setRecipientSelection((prev) => ({
                        ...prev,
                        [student.id]: e.target.checked,
                      }))
                    }
                  />
                  <span className="text-sm">{student.name}</span>
                  {student.registrationNumber ? <span className="text-xs text-muted">({student.registrationNumber})</span> : null}
                </label>
              ))}
            </div>

            <div className="mt-3 flex items-center justify-between">
              <p className="text-xs text-muted">
                Selected: {Object.values(recipientSelection).filter(Boolean).length} / {bundleDetail.students.length}
              </p>
              <button
                type="button"
                onClick={() => void saveRecipientsAndSend()}
                disabled={isSaving}
                className="rounded-xl bg-foreground px-3 py-2 text-xs font-semibold text-background disabled:opacity-60"
              >
                Save recipients & mark as sent
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Submissions side panel backdrop (mobile only) */}
      {isSubmissionsOpen && selectedBundleId ? (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => { setIsSubmissionsOpen(false); setSubmissionsItemId(null); }}
        />
      ) : null}

      {/* Submissions side panel */}
      <div
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-[560px] flex-col border-l border-brand-100 bg-white/95 shadow-[0_24px_64px_-24px_rgba(13,26,46,0.38)] backdrop-blur-xl transition-transform duration-300 ${
          isSubmissionsOpen && selectedBundleId ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="border-b border-brand-100 bg-gradient-to-b from-white to-slate-50 px-5 py-5 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand-700 shadow-soft">
                  <Files size={18} />
                </span>
                <div>
                  <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-muted">Paper Submissions</p>
                  <h4 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-slate-900">
                    {submissionsView?.item.title ?? (isLoadingSubmissions ? "Loading..." : "Submissions")}
                  </h4>
                </div>
              </div>
              <p className="mt-3 text-sm font-medium text-slate-500">{submissionsView?.classroom.name ?? "Track student uploads and late reasons."}</p>
              {submissionsView?.item.paperEndAt ? (
                <p className="mt-1 text-[13px] leading-6 text-slate-400">
                  Deadline: {new Date(submissionsView.item.paperEndAt).toLocaleString()}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => { setIsSubmissionsOpen(false); setSubmissionsItemId(null); }}
              className="btn-secondary h-10 shrink-0 px-4 text-xs"
            >
              Close
            </button>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-brand-100 bg-white px-4 py-3 shadow-soft">
              <p className="text-[12px] font-medium uppercase tracking-[0.12em] text-muted">Total students</p>
              <p className="mt-2 text-[28px] font-bold leading-none text-slate-900">{submissionsView?.summary.totalStudents ?? 0}</p>
            </div>
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 px-4 py-3 shadow-soft">
              <p className="text-[12px] font-medium uppercase tracking-[0.12em] text-emerald-700">Submitted</p>
              <p className="mt-2 text-[28px] font-bold leading-none text-emerald-700">{submissionsView?.summary.submittedStudents ?? 0}</p>
            </div>
            <div className="rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3 shadow-soft">
              <p className="text-[12px] font-medium uppercase tracking-[0.12em] text-amber-700">Not submitted</p>
              <p className="mt-2 text-[28px] font-bold leading-none text-amber-700">{submissionsView?.summary.notSubmittedStudents ?? 0}</p>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3 rounded-2xl border border-brand-100 bg-white px-4 py-3 shadow-soft">
            <Search size={18} className="text-slate-400" />
            <p className="text-sm text-slate-500">Submission records for the selected paper are listed below.</p>
          </div>
        </div>

        <div className="scrollbar-none flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {isLoadingSubmissions ? (
            <p className="text-sm text-muted">Loading submissions…</p>
          ) : null}

          {submissionsView ? (
            <div className="space-y-4">
              {submissionsView.students.map((student) => (
                <div key={student.id} className="rounded-[22px] border border-brand-100 bg-white p-4 shadow-soft">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[16px] font-semibold text-slate-900">
                        {student.name}
                        {student.registrationNumber ? ` (${student.registrationNumber})` : ""}
                      </p>
                      <p className="mt-1 text-[13px] leading-6 text-slate-400">
                        {student.hasSubmitted ? "Submission history available below." : "No submission uploaded yet."}
                      </p>
                    </div>
                    <div>
                      {student.hasSubmitted ? (
                        <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[12px] font-semibold text-emerald-700">
                          Submitted
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[12px] font-semibold text-amber-700">
                          Not submitted
                        </span>
                      )}
                    </div>
                  </div>

                  {student.hasSubmitted ? (
                    <>
                      <p className="mt-3 text-[13px] leading-6 text-slate-400">
                        Latest: {student.latestSubmittedAt ? new Date(student.latestSubmittedAt).toLocaleString() : "-"}
                      </p>
                      <div className="mt-3 space-y-2">
                        {student.submissions.map((submission) => (
                          <div key={submission.id} className="rounded-2xl border border-brand-100 bg-slate-50/70 px-3 py-3 text-sm">
                            <p className="font-semibold text-slate-900">{submission.fileName}</p>
                            <p className="mt-1 text-[13px] leading-6 text-slate-400">
                              Submitted {new Date(submission.submittedAt).toLocaleString()} • {formatBytes(submission.sizeBytes)}
                            </p>
                            <p className={`mt-1 text-[13px] font-medium ${submission.isLate ? "text-red-700" : "text-emerald-700"}`}>
                              {submission.isLate ? "Late submission" : "On-time submission"}
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <a
                                href={`/api/material-bundles/${selectedBundleId}/items/${submissionsItemId ?? submissionsView.item.id}/submissions/${submission.id}/file`}
                                target="_blank"
                                rel="noreferrer"
                                className="btn-secondary px-3 py-1.5 text-xs"
                              >
                                Preview
                              </a>
                              <a
                                href={`/api/material-bundles/${selectedBundleId}/items/${submissionsItemId ?? submissionsView.item.id}/submissions/${submission.id}/file?download=1`}
                                className="btn-secondary px-3 py-1.5 text-xs"
                              >
                                Download
                              </a>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}

                  {student.supportMessages.length > 0 ? (
                    <div className="mt-3 space-y-2 rounded-2xl border border-amber-200 bg-amber-50/80 p-3">
                      <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-amber-700">Student late reasons</p>
                      {student.supportMessages.map((msg) => (
                        <div key={msg.id} className="rounded-xl border border-amber-200 bg-white px-3 py-2.5 text-sm">
                          <p className="whitespace-pre-line text-slate-700">{msg.message}</p>
                          <p className="mt-2 text-[12px] leading-5 text-slate-400">{new Date(msg.createdAt).toLocaleString()}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="border-t border-brand-100 bg-white/95 px-5 py-4 shadow-[0_-16px_30px_-26px_rgba(13,26,46,0.35)] sm:px-6">
          <button
            type="button"
            onClick={() => { setIsSubmissionsOpen(false); setSubmissionsItemId(null); }}
            className="btn-primary h-11 w-full"
          >
            Close submissions panel
          </button>
        </div>
      </div>

      {previewItem && selectedBundleId ? (
        <div className="fixed inset-0 z-[60] bg-black/80 p-4">
          <div className="mx-auto flex h-full w-full max-w-6xl flex-col rounded-2xl bg-card">
            <div className="flex items-center justify-between border-b border-black/10 px-4 py-2 dark:border-white/10">
              <p className="truncate text-sm font-semibold">{previewItem.title}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setIsPreviewFullScreen((prev) => !prev)}
                  className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/15"
                >
                  {isPreviewFullScreen ? "Exit full screen" : "Full screen"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPreviewItem(null);
                    setIsPreviewFullScreen(false);
                  }}
                  className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/15"
                >
                  Close
                </button>
              </div>
            </div>

            <iframe
              src={`/api/material-bundles/${selectedBundleId}/items/${previewItem.id}/file`}
              title={previewItem.title}
              className={`w-full flex-1 border-0 ${isPreviewFullScreen ? "h-screen" : "h-[75vh]"}`}
            />
          </div>
        </div>
      ) : null}

      {isHelpOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-3xl rounded-3xl border border-black/10 bg-card p-5 shadow-2xl dark:border-white/10 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">About This Page</p>
                <h3 className="mt-2 text-xl font-semibold">Monthly Bundle Management</h3>
                <p className="mt-2 text-sm text-muted">
                  Manage tutes and papers by class, month, and year. Create monthly bundles, add tutes and papers as PDFs or descriptions, set paper time windows, and mark selected students as recipients when sending.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsHelpOpen(false)}
                className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/15"
              >
                Close
              </button>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-black/10 bg-white/60 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                <p className="text-sm font-semibold">What you can do here</p>
                <ul className="mt-2 space-y-2 text-sm text-muted">
                  <li>Create one bundle for a specific class, month, and year.</li>
                  <li>Add tutes or papers with PDF files, descriptions, or both.</li>
                  <li>Set start and end times for papers when they should be available.</li>
                  <li>Select which students should receive the bundle before sending.</li>
                </ul>
              </div>

              <div className="rounded-2xl border border-black/10 bg-white/60 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                <p className="text-sm font-semibold">How the send flow works</p>
                <ul className="mt-2 space-y-2 text-sm text-muted">
                  <li>Choose recipients and mark the bundle as sent.</li>
                  <li>The teacher view shows exactly which students were selected.</li>
                  <li>Sent students remain in a waiting state until receipt is confirmed.</li>
                  <li>Confirmation status helps you track who has acknowledged the bundle.</li>
                </ul>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-brand-200 bg-brand-50 p-4 text-sm text-brand-900">
              <p className="font-semibold">Quick guide</p>
              <p className="mt-1">
                Start by creating the bundle, add the monthly tutes and papers, review the recipient list, and then use <span className="font-semibold">Save recipients & mark as sent</span> when the bundle is ready.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {isCreatePanelOpen ? (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/35"
            onClick={() => setIsCreatePanelOpen(false)}
            aria-hidden
          />

          <aside className="drawer-panel scrollbar-none z-50 w-full max-w-[520px] border-l border-brand-100 bg-white/98 p-0 shadow-2xl">
            <div className="flex h-full flex-col">
              <div className="border-b border-brand-100 bg-gradient-to-r from-brand-50 via-white to-slate-50 px-6 py-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">Create New Bundle</p>
                    <h4 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-4xl">Monthly bundle details</h4>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsCreatePanelOpen(false)}
                    className="btn-secondary h-10 w-10 rounded-xl p-0"
                    aria-label="Close create bundle panel"
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>

              <div className="scrollbar-none flex-1 space-y-6 overflow-y-auto px-6 py-6">
                <section className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Class</p>
                  <div className="relative">
                    <GraduationCap size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
                    <ChevronDown size={16} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-muted" />
                    <select
                      value={createClassId}
                      onChange={(e) => setCreateClassId(e.target.value)}
                      className="control-select h-14 appearance-none pl-11 pr-12 text-base"
                    >
                      <option value="">Select class</option>
                      {classes.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </section>

                <section className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Bundle title</p>
                  <div className="relative">
                    <FileText size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
                    <input
                      type="text"
                      placeholder="e.g. Monthly Tutes"
                      value={createTitle}
                      onChange={(e) => setCreateTitle(e.target.value)}
                      className="control-input h-14 pl-11 pr-16 text-base"
                    />
                    <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted">
                      {createTitle.length}/60
                    </span>
                  </div>
                </section>

                <section className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Period</p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="relative">
                      <Calendar size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
                      <input
                        type="number"
                        value={createYear}
                        onChange={(e) => setCreateYear(e.target.value)}
                        className="control-input h-14 pl-11 text-base"
                      />
                    </div>
                    <div className="relative">
                      <ChevronDown size={16} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-muted" />
                      <select
                        value={createMonth}
                        onChange={(e) => setCreateMonth(e.target.value)}
                        className="control-select h-14 appearance-none pr-12 text-base"
                      >
                        {Array.from({ length: 12 }).map((_, idx) => (
                          <option key={idx + 1} value={String(idx + 1)}>
                            {monthLabel(idx + 1)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </section>

                <div className="notice-info">
                  A new bundle will be created for the selected class, year, and month. You can add tutes and papers after creating the bundle.
                </div>
              </div>

              <div className="border-t border-brand-100 bg-white px-6 py-5">
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setIsCreatePanelOpen(false)}
                    className="btn-secondary flex-1"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void handleCreateBundle();
                      setIsCreatePanelOpen(false);
                    }}
                    disabled={isSaving}
                    className="btn-primary flex-1 gap-2 disabled:opacity-60"
                  >
                    <Plus size={14} />
                    {isSaving ? "Creating..." : "Create bundle"}
                  </button>
                </div>
              </div>
            </div>
          </aside>
        </>
      ) : null}

      {isItemPanelOpen && bundleDetail && selectedBundleId ? (
        <div className="scrollbar-none fixed inset-y-0 right-0 z-50 w-full max-w-[540px] overflow-y-auto border-l border-brand-100 bg-white/95 shadow-[0_24px_64px_-24px_rgba(13,26,46,0.38)] backdrop-blur-xl">
          <div className="sticky top-0 border-b border-brand-100 bg-gradient-to-b from-white to-slate-50 px-5 py-5 sm:px-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand-700 shadow-soft">
                    <Files size={18} />
                  </span>
                  <div>
                    <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-muted">Add Item</p>
                    <h4 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-slate-900">Add tute / paper</h4>
                  </div>
                </div>
                <p className="mt-3 text-sm font-medium text-slate-500">
                  {bundleDetail.title} • {monthLabel(bundleDetail.month)} {bundleDetail.year}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsItemPanelOpen(false)}
                className="btn-secondary h-10 shrink-0 px-4 text-xs"
              >
                Close
              </button>
            </div>
          </div>

          <div className="space-y-5 p-5 sm:p-6">
            {bundleDetail.status === "SENT" ? (
              <div className="rounded-[20px] border border-amber-300 bg-amber-50/90 p-4 text-sm text-amber-800 shadow-soft">
                <p className="font-semibold">Warning: bundle already sent</p>
                <p className="mt-2 leading-6">
                  This bundle was already sent
                  {bundleDetail.sentAt ? ` on ${new Date(bundleDetail.sentAt).toLocaleString()}` : ""}. Adding new items now will not automatically re-send to students.
                </p>
                <label className="mt-4 flex items-start gap-3 rounded-2xl border border-amber-200 bg-white/70 px-3 py-3 text-xs">
                  <input
                    type="checkbox"
                    checked={confirmAddToSentBundle}
                    onChange={(e) => setConfirmAddToSentBundle(e.target.checked)}
                  />
                  <span>I understand and confirm adding an item to an already sent bundle.</span>
                </label>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2">
                <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-muted">Item type</span>
                <select
                  value={itemType}
                  onChange={(e) => setItemType(e.target.value as "TUTE" | "PAPER")}
                  className="control-select h-14 text-[15px]"
                >
                  <option value="TUTE">Tute</option>
                  <option value="PAPER">Paper</option>
                </select>
              </label>
              <label className="space-y-2">
                <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-muted">Title</span>
                <input
                  value={itemTitle}
                  onChange={(e) => setItemTitle(e.target.value)}
                  placeholder="Title"
                  className="control-input h-14 text-[15px]"
                />
              </label>
            </div>

            <label className="block space-y-2">
              <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-muted">Description</span>
              <textarea
                value={itemDescription}
                onChange={(e) => setItemDescription(e.target.value)}
                rows={4}
                placeholder="Description (optional)"
                className="control-textarea min-h-[120px] text-[15px] leading-6"
              />
            </label>

            <label className="block space-y-2">
              <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-muted">PDF file</span>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => setItemFile(e.target.files?.[0] ?? null)}
                className="block w-full rounded-2xl border border-brand-200 bg-white px-4 py-3 text-sm file:mr-4 file:rounded-xl file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:font-semibold file:text-brand-700"
              />
            </label>

            {itemType === "PAPER" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-muted">Start time</span>
                  <input
                    type="datetime-local"
                    value={paperStartAt}
                    onChange={(e) => setPaperStartAt(e.target.value)}
                    className="control-input h-14 text-[15px]"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-muted">End time</span>
                  <input
                    type="datetime-local"
                    value={paperEndAt}
                    onChange={(e) => setPaperEndAt(e.target.value)}
                    className="control-input h-14 text-[15px]"
                  />
                </label>
              </div>
            ) : null}

            <div className="flex gap-3 border-t border-brand-100 pt-4">
              <button
                type="button"
                onClick={() => setIsItemPanelOpen(false)}
                className="btn-secondary flex-1"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleAddItem()}
                disabled={isSaving || (bundleDetail.status === "SENT" && !confirmAddToSentBundle)}
                className="btn-primary flex-1 disabled:opacity-60"
              >
                {isSaving ? "Adding..." : "Add item"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
